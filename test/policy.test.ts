import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { requestApproval } from "../server/governance/policy.js";
import { engage } from "../server/governance/killswitch.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import { setActiveEligible } from "../server/ownership/allowlist.js";
import { HARD_CAPS } from "../server/governance/limits.js";
import { listAudit } from "../server/audit/log.js";

/** Marks a seeded domain as proven, so policy tests can focus on one rule. */
async function prove(db: ReturnType<typeof freshDb>, domain: string) {
  const { token } = createChallenge(db, domain, "op")!;
  await verifyOwnership(db, domain, "dns-txt", "op", { resolveTxt: async () => [[token]] });
}

describe("policy engine (fail-closed gate)", () => {
  it("denies a target not on the allowlist", () => {
    const db = freshDb();
    const d = requestApproval(db, { actor: "op", target: "https://evil.example", mode: "passive" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/not on the allowlist/);
  });

  it("denies an allowlisted but unproven target", () => {
    const db = freshDb();
    const d = requestApproval(db, { actor: "op", target: "eendigo.com", mode: "passive" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/not proven/);
  });

  it("allows passive scanning of a proven target", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    const d = requestApproval(db, { actor: "op", target: "https://eendigo.com", mode: "passive" });
    expect(d.allowed).toBe(true);
    expect(d.host).toBe("eendigo.com");
    expect(d.effectiveLimits?.allowDataMutating).toBe(false);
  });

  it("denies active mode unless the target is active-eligible", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    const denied = requestApproval(db, { actor: "op", target: "eendigo.com", mode: "active" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/active mode is not permitted/);

    setActiveEligible(db, "eendigo.com", true, "op");
    const allowed = requestApproval(db, { actor: "op", target: "eendigo.com", mode: "active" });
    expect(allowed.allowed).toBe(true);
  });

  it("denies everything while the kill switch is engaged", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    engage(db, "op", "test");
    const d = requestApproval(db, { actor: "op", target: "eendigo.com", mode: "passive" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/kill switch/);
  });

  it("denies when requested limits exceed a hard cap", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    const d = requestApproval(db, {
      actor: "op",
      target: "eendigo.com",
      mode: "passive",
      limits: { maxTotalRequests: HARD_CAPS.maxTotalRequests + 1 },
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/exceeds hard cap/);
  });

  it("denies a request to enable data-mutating operations", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    const d = requestApproval(db, {
      actor: "op",
      target: "eendigo.com",
      mode: "passive",
      limits: { allowDataMutating: true },
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/data-mutating/);
  });

  it("records every decision in the audit trail", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    requestApproval(db, { actor: "op", target: "eendigo.com", mode: "passive" });
    requestApproval(db, { actor: "op", target: "evil.example", mode: "passive" });
    const approvals = listAudit(db).filter((r) => r.action === "scan.approve");
    expect(approvals.some((r) => r.decision === "allow")).toBe(true);
    expect(approvals.some((r) => r.decision === "deny")).toBe(true);
  });
});
