import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { runActiveScan } from "../server/scan/active.js";
import { getFindings, listScans } from "../server/scan/passive.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import { setActiveEligible } from "../server/ownership/allowlist.js";
import { engage } from "../server/governance/killswitch.js";
import { listAudit } from "../server/audit/log.js";
import type { AuthAttemptResult, HttpResult, TlsResult } from "../server/scan/types.js";

async function prove(db: ReturnType<typeof freshDb>, domain: string) {
  const { token } = createChallenge(db, domain, "op")!;
  await verifyOwnership(db, domain, "dns-txt", "op", { resolveTxt: async () => [[token]] });
}

async function proveAndEnableActive(db: ReturnType<typeof freshDb>, domain: string) {
  await prove(db, domain);
  setActiveEligible(db, domain, true, "op");
}

/** A fake HTTP probe driven by a path -> status map. 404 for anything else. */
function fakeHttpByPath(statuses: Record<string, number>, noisePathStatus = 404) {
  return async (url: string): Promise<HttpResult> => {
    const path = new URL(url).pathname;
    let status = statuses[path];
    if (status === undefined) {
      // The baseline probe uses a random /secval-probe-* path.
      status = path.startsWith("/secval-probe-") ? noisePathStatus : 404;
    }
    return { status, headers: {}, setCookies: [] };
  };
}

const goodTls: TlsResult = { protocol: "TLSv1.3", validTo: "2035-01-01T00:00:00Z", authorized: true };
// A clean DNS posture (good SPF, enforcing DMARC, a CAA record) -> no findings.
const goodDns = {
  txt: ["v=spf1 -all"],
  dmarcTxt: ["v=DMARC1; p=reject"],
  caa: ["issue letsencrypt.org"],
};

// Shared defaults: no real delays, a healthy TLS handshake, and a clean DNS
// posture so tests never touch the network. Tests still supply their httpProbe.
const noWait = { sleep: async () => {}, tlsProbe: async () => goodTls, dnsProbe: async () => goodDns };

describe("active scan (gated)", () => {
  it("denies a proven target that is NOT active-eligible and runs no probe", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com"); // proven, but not active-eligible
    let probed = false;
    const result = await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com" },
      { httpProbe: async () => { probed = true; return { status: 200, headers: {}, setCookies: [] }; }, ...noWait },
    );
    expect(result.status).toBe("denied");
    expect(result.reason).toMatch(/active mode is not permitted/);
    expect(probed).toBe(false);
  });

  it("denies an unproven target", async () => {
    const db = freshDb();
    const result = await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com" },
      { httpProbe: fakeHttpByPath({}), ...noWait },
    );
    expect(result.status).toBe("denied");
    expect(result.reason).toMatch(/not proven/);
  });

  it("scans an active-eligible target and reports exposed paths", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    const result = await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com" },
      { httpProbe: fakeHttpByPath({ "/.env": 200, "/server-status": 403 }), ...noWait },
    );
    expect(result.status).toBe("completed");
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain("exposed-env"); // 200 -> exposed
    expect(codes).toContain("exposed-server-status-protected"); // 403 -> present but protected

    // Persisted, and findings never carry target data (only static detail).
    const stored = getFindings(db, result.scanId!);
    expect(stored.length).toBe(result.findings.length);
  });

  it("reports nothing exposed when every sensitive path 404s", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    const result = await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com" },
      { httpProbe: fakeHttpByPath({}), ...noWait },
    );
    expect(result.status).toBe("completed");
    // No exposed-file findings when every sensitive path 404s. (Homepage
    // header checks may still report, so we assert specifically on exposure.)
    expect(result.findings.some((f) => f.code.startsWith("exposed-"))).toBe(false);
  });

  it("short-circuits on a catch-all server (2xx for unknown paths)", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    let probeCount = 0;
    const http = async (url: string): Promise<HttpResult> => {
      probeCount++;
      void url;
      return { status: 200, headers: {}, setCookies: [] }; // everything 2xx
    };
    const result = await runActiveScan(db, { actor: "op", target: "eendigo.com" }, { httpProbe: http, ...noWait });
    expect(result.status).toBe("completed");
    // Baseline flags catch-all, and NO sensitive-path exposure check runs.
    expect(result.findings.map((f) => f.code)).toContain("exposed-check-inconclusive");
    expect(result.findings.some((f) => f.code !== "exposed-check-inconclusive" && f.code.startsWith("exposed-"))).toBe(false);
    // Baseline + homepage + plain-HTTP + OPTIONS ran; the path loop was skipped.
    expect(probeCount).toBe(4);
  });

  it("honors the kill switch and runs no probe", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    engage(db, "op", "test");
    let probed = false;
    const result = await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com" },
      { httpProbe: async () => { probed = true; return { status: 200, headers: {}, setCookies: [] }; }, ...noWait },
    );
    expect(result.status).toBe("denied"); // policy engine denies up front
    expect(probed).toBe(false);
  });

  it("caps total requests to the approved limit", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    let probeCount = 0;
    const http = async (url: string): Promise<HttpResult> => {
      probeCount++;
      const path = new URL(url).pathname;
      return { status: path.startsWith("/secval-probe-") ? 404 : 200, headers: {}, setCookies: [] };
    };
    // Simulate the runtime budget running out right after the baseline probe:
    // the start time and the pre-baseline check read 0, the next check jumps
    // past maxRuntimeMs so no sensitive-path probe is sent.
    let calls = 0;
    const now = () => (++calls <= 2 ? 0 : 100_000);
    const result = await runActiveScan(db, { actor: "op", target: "eendigo.com" }, { httpProbe: http, now, ...noWait });
    expect(result.status).toBe("completed");
    // Budget exhausted after the baseline probe -> no sensitive-path probes.
    expect(probeCount).toBe(1);
  });

  it("flags a login endpoint with no rate-limiting", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    let authCount = 0;
    const authProbe = async (): Promise<AuthAttemptResult> => {
      authCount++;
      return { status: 401, rateLimited: false }; // always same, never throttled
    };
    const result = await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com", loginPath: "/login" },
      { httpProbe: fakeHttpByPath({}), authProbe, ...noWait },
    );
    expect(result.status).toBe("completed");
    expect(result.findings.map((f) => f.code)).toContain("no-login-rate-limit");
    expect(authCount).toBe(5); // hard cap on login attempts
  });

  it("detects login rate-limiting and stops hammering early", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    let authCount = 0;
    const authProbe = async (): Promise<AuthAttemptResult> => {
      authCount++;
      // First attempt ok, second is throttled.
      return authCount >= 2 ? { status: 429, rateLimited: true } : { status: 401, rateLimited: false };
    };
    const result = await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com", loginPath: "/login" },
      { httpProbe: fakeHttpByPath({}), authProbe, ...noWait },
    );
    expect(result.status).toBe("completed");
    expect(result.findings.map((f) => f.code)).toContain("login-rate-limit-present");
    expect(authCount).toBe(2); // stopped as soon as throttling was observed
  });

  it("skips the login check when no loginPath is given", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    let authCount = 0;
    const authProbe = async (): Promise<AuthAttemptResult> => {
      authCount++;
      return { status: 401, rateLimited: false };
    };
    const result = await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com" },
      { httpProbe: fakeHttpByPath({}), authProbe, ...noWait },
    );
    expect(result.status).toBe("completed");
    expect(authCount).toBe(0);
    expect(result.findings.some((f) => f.code.startsWith("login-") || f.code === "no-login-rate-limit")).toBe(false);
  });

  it("records the active scan in history and the audit trail", async () => {
    const db = freshDb();
    await proveAndEnableActive(db, "eendigo.com");
    await runActiveScan(
      db,
      { actor: "op", target: "eendigo.com" },
      { httpProbe: fakeHttpByPath({ "/.git/config": 200 }), ...noWait },
    );
    const scans = listScans(db);
    expect(scans.some((s) => s.mode === "active" && s.status === "completed")).toBe(true);

    const audit = listAudit(db, 100);
    const actions = audit.filter((a) => a.mode === "active").map((a) => a.action);
    expect(actions).toContain("scan.start");
    expect(actions).toContain("scan.complete");
  });
});
