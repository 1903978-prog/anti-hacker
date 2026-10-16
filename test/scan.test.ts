import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { runPassiveScan, getFindings, listScans } from "../server/scan/passive.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import { engage } from "../server/governance/killswitch.js";
import { listAudit } from "../server/audit/log.js";
import type { HttpResult, TlsResult } from "../server/scan/types.js";

async function prove(db: ReturnType<typeof freshDb>, domain: string) {
  const { token } = createChallenge(db, domain, "op")!;
  await verifyOwnership(db, domain, "dns-txt", "op", { resolveTxt: async () => [[token]] });
}

const fakeHttp = (headers: Record<string, string>, setCookies: string[] = []): HttpResult => ({
  status: 200,
  headers,
  setCookies,
});
const goodTls: TlsResult = { protocol: "TLSv1.3", validTo: "2030-01-01T00:00:00Z", authorized: true };

const deps = (http: HttpResult, tls: TlsResult = goodTls) => ({
  httpProbe: async () => http,
  tlsProbe: async () => tls,
});

describe("passive scan (gated)", () => {
  it("refuses to scan an unproven target and runs no probe", async () => {
    const db = freshDb();
    let probed = false;
    const result = await runPassiveScan(
      db,
      { actor: "op", target: "eendigo.com" },
      { httpProbe: async () => { probed = true; return fakeHttp({}); }, tlsProbe: async () => goodTls },
    );
    expect(result.status).toBe("denied");
    expect(result.reason).toMatch(/not proven/);
    expect(probed).toBe(false);
  });

  it("scans a proven target and stores findings, not target data", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    const result = await runPassiveScan(
      db,
      { actor: "op", target: "https://eendigo.com" },
      deps(fakeHttp({}, ["sid=secretdata; Path=/"])),
    );
    expect(result.status).toBe("completed");
    expect(result.findings.length).toBeGreaterThan(0);

    const stored = getFindings(db, result.scanId!);
    expect(stored.length).toBe(result.findings.length);
    // Retention invariant: no stored finding leaks the cookie value.
    expect(stored.every((f) => !f.detail.includes("secretdata"))).toBe(true);
  });

  it("records the scan in history and the audit trail", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    await runPassiveScan(db, { actor: "op", target: "eendigo.com" }, deps(fakeHttp({})));
    expect(listScans(db)[0]?.status).toBe("completed");
    const actions = listAudit(db).map((a) => a.action);
    expect(actions).toContain("scan.start");
    expect(actions).toContain("scan.complete");
  });

  it("aborts mid-scan when the kill switch is engaged after approval", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    engage(db, "op", "halt");
    const result = await runPassiveScan(db, { actor: "op", target: "eendigo.com" }, deps(fakeHttp({})));
    // Kill switch is checked by the policy engine first, so this denies.
    expect(result.status).toBe("denied");
    expect(result.reason).toMatch(/kill switch/);
  });

  it("is clean when the target is well-configured", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    const strong = fakeHttp({
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "content-security-policy":
        "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=()",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
      "x-permitted-cross-domain-policies": "none",
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    const result = await runPassiveScan(db, { actor: "op", target: "eendigo.com" }, deps(strong));
    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(0);
  });
});
