import { describe, expect, it } from "vitest";
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { checkCriteria, eeesView, EEES_DIR, loadRegistry } from "../server/eees/registry.js";
import { flowResults, portfolioIndex, scoreApp } from "../server/eees/engine.js";
import type { AppEntry, Criteria, EvidenceFile } from "../server/eees/types.js";

const NOW = new Date("2026-11-12T12:00:00Z");
const reg = loadRegistry();
const criteria: Criteria = reg.criteria;
const APP: AppEntry = { id: "demo", name: "Demo", kind: "application", tier: "critical", owner: "demo thread", repo: null, hosts: [], evidence: "evidence/demo.json" };

function evidence(over: Partial<EvidenceFile> = {}): EvidenceFile {
  return {
    standard: "EEES", standardVersion: "1.0.0", app: "demo", assessedAt: "2026-11-12", assessor: "test",
    productionVersion: null, lastIndependentVerification: null, checks: {}, dimensionsNA: {}, gates: {},
    releaseGates: {}, defects: [], history: [], notes: [], ...over,
  };
}
const prod = (link = "query.sql") => [{ link, kind: "measurement" as const, date: "2026-11-12", environment: "production" as const }];
/** Every check of the standard verified at one level. */
function allVerified(level: "synthetic" | "prodlike" | "production" | "independent-sustained"): EvidenceFile["checks"] {
  const out: EvidenceFile["checks"] = {};
  for (const d of criteria.dimensions)
    for (const c of d.checks) out[c.id] = { status: "verified", level, evidence: [{ ...prod()[0]!, reviewer: "Human reviewer" }] };
  return out;
}
const passGates = Object.fromEntries(["G1", "G2", "G3", "G4", "G5", "G6"].map((g) => [g, { status: "pass" as const, evidence: prod() }]));

describe("EEES v1.0 standard files", () => {
  it("has exactly 30 dimensions in 5 domains whose weights add up to 100%", () => {
    expect(checkCriteria(criteria)).toEqual([]);
    expect(criteria.dimensions).toHaveLength(30);
    expect(criteria.domains.map((d) => [d.id, d.weight])).toEqual([["DATA", 21], ["SEC", 24], ["BIZ", 22], ["OPS", 20], ["ENG", 13]]);
    expect(criteria.dimensions.find((d) => d.id === "D08")).toMatchObject({ name: "Authorization and data isolation", weight: 5 });
    expect(criteria.dimensions.find((d) => d.id === "D23")).toMatchObject({ name: "Backups, disaster recovery and recoverability", weight: 5 });
    for (const d of criteria.dimensions) {
      expect(d.definitionOf10.length).toBeGreaterThan(20);
      for (const c of d.checks) expect(c.acceptance.length).toBeGreaterThan(10);
    }
  });

  it("loads every repository evidence file without problems", () => {
    expect(reg.problems).toEqual([]);
    expect(reg.evidence.size).toBe(reg.apps.apps.length);
  });

  it("flags a broken standard (weights not 100)", () => {
    const broken = structuredClone(criteria);
    broken.dimensions[0]!.weight = 9;
    expect(checkCriteria(broken).join(" ")).toMatch(/add up to 105/);
  });
});

describe("EEES scoring rules", () => {
  it("scores nothing when there is no evidence: UNKNOWN is 0, never a pass", () => {
    const s = scoreApp(criteria, APP, null, null, {}, NOW);
    expect(s.assured).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.hasEvidence).toBe(false);
    expect(s.dimensions.every((d) => d.state === "unknown")).toBe(true);
    expect(s.releaseStatus).toBe("NOT READY");
  });

  it("applies evidence ceilings: synthetic 6, production-like 8, production 9, independent sustained 10", () => {
    const at = (level: Parameters<typeof allVerified>[0]) =>
      scoreApp(criteria, APP, evidence({ checks: allVerified(level), gates: passGates }), null, {}, NOW).assured;
    expect(at("synthetic")).toBe(6);
    expect(at("prodlike")).toBe(8);
    expect(at("production")).toBe(9);
    expect(at("independent-sustained")).toBe(10);
  });

  it("independent-sustained without a named reviewer counts as production only", () => {
    const checks = allVerified("independent-sustained");
    for (const c of Object.values(checks)) c.evidence = prod();
    const s = scoreApp(criteria, APP, evidence({ checks, gates: passGates }), null, {}, NOW);
    expect(s.assured).toBe(9);
  });

  it("does not count a coding agent's claim, a missing link or expired evidence", () => {
    const s = scoreApp(
      criteria, APP,
      evidence({
        checks: {
          "D01.1": { status: "verified", level: "production", evidence: [{ link: "chat", kind: "agent-claim", date: "2026-11-12", environment: "production" }] },
          "D01.2": { status: "verified", level: "production", evidence: [] },
          "D01.3": { status: "verified", level: "production", evidence: [{ link: "q", kind: "measurement", date: "2026-01-01", environment: "production" }] },
        },
      }),
      null, {}, NOW,
    );
    const d1 = s.dimensions.find((d) => d.id === "D01")!;
    expect(d1.counts.verified).toBe(0);
    expect(d1.checks[0]!.reason).toMatch(/agent's claim/);
    expect(d1.checks[1]!.reason).toMatch(/without an evidence link/);
    expect(d1.checks[2]!.reason).toMatch(/older than/);
  });

  it("allows N/A only with justification and reviewer, and redistributes its weight inside the domain", () => {
    const checks = allVerified("production");
    const without = scoreApp(criteria, APP, evidence({ checks: { ...checks, "D17.1": { status: "na", evidence: [] } }, gates: passGates }), null, {}, NOW);
    expect(without.dimensions.find((d) => d.id === "D17")!.counts.unknown).toBe(1);

    const na = scoreApp(
      criteria, APP,
      evidence({ checks, gates: passGates, dimensionsNA: { D17: { justification: "no AI feature", reviewer: "Livio" } } }),
      null, {}, NOW,
    );
    const d17 = na.dimensions.find((d) => d.id === "D17")!;
    expect(d17.state).toBe("na");
    const biz = na.dimensions.filter((d) => d.domain === "BIZ" && d.state !== "na");
    expect(biz.reduce((s, d) => s + d.effectiveWeight, 0)).toBeCloseTo(22, 1);
    expect(na.assured).toBe(9);
  });

  it("hard gates cap the score and a high average never overrides them", () => {
    const checks = allVerified("independent-sustained");
    const run = (defects: EvidenceFile["defects"]) =>
      scoreApp(criteria, APP, evidence({ checks, gates: passGates, defects }), null, {}, NOW);
    const sec = run([{ id: "X1", title: "leaked key", severity: "P0", category: "security", status: "open", exploitable: true, dimensions: ["D09"] }]);
    expect(sec.assured).toBe(3);
    expect(sec.releaseStatus).toBe("BLOCKED");
    const money = run([{ id: "X2", title: "wrong posting", severity: "P0", category: "financial", status: "fixed-unreleased", dimensions: ["D16"] }]);
    expect(money.assured).toBe(5.9);
    expect(money.releaseStatus).toBe("BLOCKED");
    const p1 = run([{ id: "X3", title: "broken workflow", severity: "P1", category: "functional", status: "open", dimensions: ["D13"] }]);
    expect(p1.assured).toBe(7.9);
    const closed = run([{ id: "X4", title: "fixed", severity: "P0", category: "financial", status: "closed-verified", dimensions: ["D16"] }]);
    expect(closed.assured).toBe(10);
  });

  it("caps at 7.9 / 8.0 / 8.9 when end-to-end, independent production or sustained evidence is missing", () => {
    const checks = allVerified("independent-sustained");
    const gates = (missing: string) => ({ ...passGates, [missing]: { status: "unknown" as const, evidence: [] } });
    expect(scoreApp(criteria, APP, evidence({ checks, gates: gates("G4") }), null, {}, NOW).assured).toBe(7.9);
    expect(scoreApp(criteria, APP, evidence({ checks, gates: gates("G5") }), null, {}, NOW).assured).toBe(8);
    expect(scoreApp(criteria, APP, evidence({ checks, gates: gates("G6") }), null, {}, NOW).assured).toBe(8.9);
  });

  it("a failed financial check measured on production blocks release (gate G2)", () => {
    const s = scoreApp(criteria, APP, evidence({ checks: { ...allVerified("production"), "D16.1": { status: "failed", evidence: prod() } }, gates: passGates }), null, {}, NOW);
    expect(s.gates.find((g) => g.id === "G2")!.status).toBe("fail");
    expect(s.releaseStatus).toBe("BLOCKED");
    expect(s.top3[0]!.check).toBe("D16.1");
  });

  it("is never release ready just because nothing failed: unassessed gates keep it NOT READY", () => {
    const s = scoreApp(criteria, APP, evidence({ checks: allVerified("production") }), null, {}, NOW);
    expect(s.releaseStatus).toBe("NOT READY");
    const ready = scoreApp(
      criteria, APP,
      evidence({ checks: allVerified("production"), gates: passGates, releaseGates: Object.fromEntries(criteria.releaseGates.map((r) => [r.id, { status: "pass" as const, evidence: prod() }])) }),
      null, {}, NOW,
    );
    expect(ready.releaseStatus).toBe("READY FOR RELEASE REVIEW");
  });
});

describe("EEES cross-application flows", () => {
  const flows = {
    standardVersion: "1.0.0", updated: "2026-11-12", requiredFields: ["producer", "consumer", "monitoring"],
    flows: [
      { id: "F1", name: "orders", producer: "a", consumer: "demo", critical: true, status: "failing" as const, measuredAt: "2026-11-12", evidence: "log", monitoring: null },
      { id: "F2", name: "prices", producer: "demo", consumer: "b", critical: false, status: "healthy" as const, measuredAt: "2026-11-12", evidence: "log", monitoring: "alerts" },
    ],
  };
  it("a failing consumed flow fails the consumer's freshness check, and missing fields fail documentation", () => {
    const r = flowResults(flows, "demo");
    expect(r["D04.2"]!.status).toBe("failed");
    expect(r["D05.4"]!.status).toBe("failed");
    expect(r["D05.4"]!.note).toMatch(/F1: 1 of 3 fields missing \(monitoring\)/);
    const s = scoreApp(criteria, APP, evidence(), flows, {}, NOW);
    expect(s.dimensions.find((d) => d.id === "D04")!.checks[1]!.source).toBe("flow inventory");
  });
  it("a producer gets no freshness penalty for a flow it only produces", () => {
    expect(flowResults(flows, "b")["D04.2"]!.status).toBe("verified");
    expect(flowResults(flows, "a")["D04.2"]).toBeUndefined();
  });
});

describe("ESII portfolio index", () => {
  it("is tier-weighted, excludes subsystems and counts unassessed apps as 0", () => {
    const top = scoreApp(criteria, APP, evidence({ checks: allVerified("production"), gates: passGates }), null, {}, NOW);
    const empty = scoreApp(criteria, { ...APP, id: "pub", tier: "public" }, null, null, {}, NOW);
    const sub = scoreApp(criteria, { ...APP, id: "sub", kind: "subsystem", parent: "demo" }, null, null, {}, NOW);
    const p = portfolioIndex(criteria, [top, empty, sub]);
    expect(p.counted.map((c) => c.id)).toEqual(["demo", "pub"]);
    expect(p.esii).toBe(Math.round(((3 * 9 + 1 * 0) / 4) * 10) / 10);
    expect(p.unassessed).toEqual(["pub", "sub"]);
  });
});

describe("GET /api/eees", () => {
  it("needs the token and returns the scored portfolio", async () => {
    const app = createApp(openDb(":memory:"), { apiToken: "t" });
    expect((await request(app).get("/api/eees")).status).toBe(401);
    const res = await request(app).get("/api/eees").set("authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.body.standard.version).toBe("1.0.0");
    expect(res.body.apps.length).toBe(10);
    expect(res.body.apps.find((a: { id: string }) => a.id === "atena").releaseStatus).toBe("BLOCKED");
  });

  it("shows a broken evidence file as a problem, not as a score", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eees-"));
    cpSync(EEES_DIR, dir, { recursive: true });
    writeFileSync(join(dir, "evidence", "secval.json"), "{ not json");
    const v = eeesView(null, dir, NOW);
    expect(v.problems.join(" ")).toMatch(/secval: .* not valid JSON/);
    expect(v.apps.find((a) => a.id === "secval")!.assured).toBe(0);
    // the repository copy is untouched
    expect(() => JSON.parse(readFileSync(join(EEES_DIR, "evidence", "secval.json"), "utf8"))).not.toThrow();
  });
});

describe("EEES production-readiness threshold", () => {
  it("needs assured >= 8, release ready, no P0/P1 and every critical-workflow floor", () => {
    const gates = Object.fromEntries(["G1", "G2", "G3", "G4", "G5", "G6"].map((g) => [g, { status: "pass" as const, evidence: prod() }]));
    const releaseGates = Object.fromEntries(criteria.releaseGates.map((r) => [r.id, { status: "pass" as const, evidence: prod() }]));
    const good = scoreApp(criteria, APP, evidence({ checks: allVerified("production"), gates, releaseGates }), null, {}, NOW);
    expect(good.readiness).toMatchObject({ meets: true, label: "PRODUCTION READY (verified)" });
    const checks = allVerified("production");
    checks["D23.3"] = { status: "failed", evidence: prod() };
    checks["D23.2"] = { status: "failed", evidence: prod() };
    const weak = scoreApp(criteria, APP, evidence({ checks, gates, releaseGates }), null, {}, NOW);
    expect(weak.readiness.meets).toBe(false);
    expect(weak.readiness.unmet.join(" ")).toMatch(/D23 .* below floor 8/);
  });
});
