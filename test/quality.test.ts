import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.js";
import { freshDb } from "./helpers.js";
import { evaluate, buildBaseline } from "../server/quality/engine.js";
import { DEFAULT_POLICY, resolvePolicy } from "../server/quality/policy.js";
import { registerSpecs } from "../server/quality/datasets/index.js";
import { validateRefresh } from "../server/quality/store.js";
import { DIMENSIONS, type DatasetSpec, type RefreshSubmission, type Row } from "../server/quality/types.js";

const SPEC: DatasetSpec = {
  id: "test.people",
  app: "test",
  title: "People",
  version: "1",
  keyFields: ["id"],
  minRecords: 1,
  fields: [
    { name: "id", type: "string", required: true },
    { name: "salary", type: "number", required: true, min: 0, max: 1_000_000 },
    { name: "team", required: true },
    { name: "source" },
  ],
  refs: [{ field: "team", reference: "teams" }],
  freshness: { field: "updated_at", maxAgeHours: 48 },
  consistency: [{ name: "net<=gross", kind: "lte", a: "net", b: "gross" }],
  accuracy: { fields: ["salary"] },
  provenance: { fields: ["source"] },
  change: { maxRemovedPct: 5, maxChangedPct: 30, maxCountJumpPct: 20, ignoreFields: ["updated_at"] },
};

const NOW = new Date("2026-11-05T10:00:00Z");
const rows = (n = 20): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, salary: 1000 + i, team: "t1", source: "hr", net: 5, gross: 8, updated_at: "2026-11-05T08:00:00Z",
  }));

function sub(over: Partial<RefreshSubmission> = {}): RefreshSubmission {
  const records = over.records ?? rows();
  return {
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    app: "test", module: "m", page: "p", dataset: "test.people", table: "public.people",
    sourceSystem: "hr-api", initiator: "livio", kind: "external_fetch",
    startedAt: "2026-11-05T09:59:00Z", finishedAt: "2026-11-05T10:00:00Z",
    operationCompleted: true, sourceReached: true,
    records,
    references: { teams: ["t1", "t2"] },
    authoritative: Object.fromEntries(records.slice(0, 5).map((r) => [String(r.id), { salary: r.salary }])),
    access: { initiatorAuthorized: true },
    ...over,
  };
}

const baselineOf = (r = rows()) => buildBaseline(SPEC, r);

beforeEach(() => registerSpecs([SPEC]));

describe("quality policy", () => {
  it("weights are the brief's and sum to 100", () => {
    expect(DEFAULT_POLICY.weights.accuracy).toBe(20);
    expect(DIMENSIONS.reduce((s, d) => s + DEFAULT_POLICY.weights[d], 0)).toBe(100);
  });
  it("accepts a valid override and rejects a bad one without half-applying it", () => {
    expect(resolvePolicy('{"minCoverage":0.5}').policy.minCoverage).toBe(0.5);
    const bad = resolvePolicy('{"weights":{"accuracy":50}}');
    expect(bad.error).toMatch(/sum to 100/);
    expect(bad.policy).toBe(DEFAULT_POLICY);
  });
});

describe("quality engine", () => {
  it("clean data with full evidence scores 100 Excellent", () => {
    const r = evaluate(SPEC, sub(), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.score).toBe(100);
    expect(r.status).toBe("Excellent");
    expect(r.outcome).toBe("PASS");
    expect(r.coverage).toBe(1);
  });

  it("no rules configured is UNVERIFIED, never a high score", () => {
    const r = evaluate(undefined, sub({ dataset: "nope" }), null, DEFAULT_POLICY, NOW);
    expect(r.score).toBeNull();
    expect(r.status).toBe("UNVERIFIED");
    expect(r.dimensions.every((d) => d.state === "unverified")).toBe(true);
  });

  it("source not reached is UNVERIFIED, not 100", () => {
    const r = evaluate(SPEC, sub({ sourceReached: false }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.score).toBeNull();
  });

  it("untested dimensions count 0 and low coverage gives UNVERIFIED", () => {
    // No authoritative values (20), no references (15), no access report (2): 63% coverage.
    const r = evaluate(SPEC, sub({ authoritative: undefined, references: undefined, access: undefined }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.coverage).toBeCloseTo(0.63, 2);
    expect(r.status).toBe("UNVERIFIED");
    // Only access missing: 98% coverage, score is capped at 98 because it counts 0.
    const r2 = evaluate(SPEC, sub({ access: undefined }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r2.score).toBe(98);
    expect(r2.dimensions.find((d) => d.id === "access")?.state).toBe("unverified");
  });

  it("not-applicable dimensions (documented in the spec) are renormalized", () => {
    const spec = { ...SPEC, notApplicable: { accuracy: "No authoritative source exists for this dataset." } };
    const r = evaluate(spec, sub({ authoritative: undefined }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.score).toBe(100);
    expect(r.coverage).toBe(1);
  });

  it("duplicate business identities are critical and cap the score", () => {
    const records = [...rows(), { ...rows()[0] }];
    const r = evaluate(SPEC, sub({ records }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.critical).toBe(true);
    expect(r.status).toBe("Critical");
    expect(r.outcome).toBe("FAIL");
    expect(r.score!).toBeLessThanOrEqual(49);
    expect(r.rawScore!).toBeGreaterThan(49);
  });

  it("a broken required relationship is critical", () => {
    const records = rows();
    records[3] = { ...records[3], team: "ghost" };
    const r = evaluate(SPEC, sub({ records }), baselineOf(records), DEFAULT_POLICY, NOW);
    expect(r.critical).toBe(true);
    expect(r.issues.some((i) => i.code === "broken_team")).toBe(true);
  });

  it("zero records when records are expected is FAIL", () => {
    const r = evaluate(SPEC, sub({ records: [], authoritative: undefined }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.outcome).toBe("FAIL");
    expect(r.criticalReasons.join(" ")).toMatch(/at least 1 records/);
  });

  it("a security violation is critical whatever the score", () => {
    const r = evaluate(SPEC, sub({ access: { initiatorAuthorized: true, violations: ["token reused from another app"] } }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.score!).toBeLessThanOrEqual(49);
    expect(r.status).toBe("Critical");
    expect(r.outcome).toBe("FAIL");
  });

  it("a failed operation is FAIL", () => {
    const r = evaluate(SPEC, sub({ operationCompleted: false }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.outcome).toBe("FAIL");
  });

  it("a local reload or cache without source verification does not establish freshness", () => {
    const r = evaluate(SPEC, sub({ kind: "cache", sourceReached: null }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(r.dimensions.find((d) => d.id === "freshness")?.state).toBe("unverified");
    const ok = evaluate(SPEC, sub({ kind: "cache", sourceReached: true, sourceUnchangedConfirmed: true }), baselineOf(), DEFAULT_POLICY, NOW);
    expect(ok.dimensions.find((d) => d.id === "freshness")?.score).toBe(100);
  });

  it("stale data loses freshness points", () => {
    const records = rows().map((r) => ({ ...r, updated_at: "2026-11-01T00:00:00Z" }));
    const r = evaluate(SPEC, sub({ records }), baselineOf(records), DEFAULT_POLICY, NOW);
    const f = r.dimensions.find((d) => d.id === "freshness")!;
    expect(f.score!).toBeLessThan(100);
    expect(r.score!).toBeLessThan(100);
  });

  it("wrong values against the authoritative source lower accuracy", () => {
    const records = rows();
    const s = sub({ records });
    s.records = records.map((r, i) => (i < 2 ? { ...r, salary: 1 } : r));
    const r = evaluate(SPEC, s, baselineOf(records), DEFAULT_POLICY, NOW);
    expect(r.dimensions.find((d) => d.id === "accuracy")!.score!).toBe(60);
  });

  it("invalid and missing values are separate: missing hits completeness, bad range hits validity", () => {
    const records = rows();
    records[0] = { ...records[0], salary: -5 };
    records[1] = { ...records[1], salary: null };
    const r = evaluate(SPEC, sub({ records, authoritative: undefined }), baselineOf(records), DEFAULT_POLICY, NOW);
    expect(r.dimensions.find((d) => d.id === "validity")!.score!).toBeLessThan(100);
    expect(r.dimensions.find((d) => d.id === "completeness")!.score!).toBeLessThan(100);
  });

  it("consistency rule breaks are found", () => {
    const records = rows().map((r, i) => (i === 0 ? { ...r, net: 99 } : r));
    const r = evaluate(SPEC, sub({ records }), baselineOf(records), DEFAULT_POLICY, NOW);
    expect(r.issues.some((i) => i.code === "rule_net<=gross")).toBe(true);
  });

  it("reconciliation counts added / updated / removed / unchanged and flags unexplained losses", () => {
    const before = rows(20);
    const after = rows(20).slice(5).map((r, i) => (i === 0 ? { ...r, salary: 9 } : r)).concat([{ ...rows()[0], id: "new1" }]);
    const r = evaluate(SPEC, sub({ records: after }), baselineOf(before), DEFAULT_POLICY, NOW);
    expect(r.reconciliation).toMatchObject({ before: 20, after: 16, added: 1, removed: 5, updated: 1, unchanged: 14, unexplainedRemoved: 5 });
    expect(r.dimensions.find((d) => d.id === "change")!.score!).toBeLessThan(100);
    // The same loss explained by the source is not penalised for removals.
    const ex = evaluate(SPEC, sub({ records: after, expectedChange: { removed: 5, added: 1 } }), baselineOf(before), DEFAULT_POLICY, NOW);
    expect(ex.issues.some((i) => i.code === "unexplained_removals")).toBe(false);
  });

  it("first run has no baseline: change is UNVERIFIED", () => {
    const r = evaluate(SPEC, sub(), null, DEFAULT_POLICY, NOW);
    expect(r.dimensions.find((d) => d.id === "change")?.state).toBe("unverified");
    expect(r.reconciliation?.baseline).toBe(true);
  });

  it("is deterministic", () => {
    const s = sub({ jobId: "fixed" });
    expect(evaluate(SPEC, s, baselineOf(), DEFAULT_POLICY, NOW)).toEqual(evaluate(SPEC, s, baselineOf(), DEFAULT_POLICY, NOW));
  });
});

describe("quality persistence and API", () => {
  it("stores the audit, keeps the last good snapshot, and is append-only", () => {
    const db = freshDb();
    const first = validateRefresh(db, sub({ jobId: "j1" }), DEFAULT_POLICY, NOW);
    expect(first.reconciliation?.baseline).toBe(true);
    const second = validateRefresh(db, sub({ jobId: "j2" }), DEFAULT_POLICY, NOW);
    expect(second.reconciliation?.unchanged).toBe(20);
    // A failed refresh does not replace the baseline.
    validateRefresh(db, sub({ jobId: "j3", records: [], operationCompleted: false }), DEFAULT_POLICY, NOW);
    const snap = db.prepare(`SELECT job_id, record_count FROM quality_snapshots`).get();
    expect(snap).toEqual({ job_id: "j2", record_count: 20 });
    expect(() => db.prepare(`DELETE FROM quality_runs`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`UPDATE quality_runs SET score = 1`).run()).toThrow(/append-only/);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'data-quality-validation'`).get()).toEqual({ c: 3 });
  });

  it("API: validate, summary, run detail, duplicate job id, bad input", async () => {
    const db = freshDb();
    const app = createApp(db, { apiToken: "t" });
    const auth = { authorization: "Bearer t" };
    const ok = await request(app).post("/api/quality/validate").set(auth).send(sub({ jobId: "api1" }));
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBeDefined();
    expect((await request(app).post("/api/quality/validate").set(auth).send(sub({ jobId: "api1" }))).status).toBe(409);
    expect((await request(app).post("/api/quality/validate").set(auth).send({ jobId: "x" })).status).toBe(400);
    const summary = await request(app).get("/api/quality/summary").set(auth);
    expect(summary.body).toHaveLength(1);
    const runs = await request(app).get("/api/quality/runs?dataset=test.people").set(auth);
    const detail = await request(app).get(`/api/quality/runs/${runs.body[0].id}`).set(auth);
    expect(detail.body.dimensions).toHaveLength(10);
    expect((await request(app).get("/api/quality/policy").set(auth)).body.policy.version).toBe("dq-1.0.0");
  });

  it("API still rejects large bodies on other routes", async () => {
    const app = createApp(freshDb(), { apiToken: "t" });
    const big = await request(app).post("/api/allowlist").set({ authorization: "Bearer t" }).send({ domain: "a".repeat(40_000) });
    expect(big.status).toBeGreaterThanOrEqual(400); // rejected (existing handler answers 500 for oversized bodies)
  });
});

describe("compplan dataset specs", () => {
  it("hubspot_contacts is registered and scores a clean refresh with a baseline", async () => {
    const { getSpec } = await import("../server/quality/datasets/index.js");
    const spec = getSpec("compplan.hubspot_contacts")!;
    expect(spec).toBeDefined();
    const recs = Array.from({ length: 10 }, (_, i) => ({
      hubspot_id: `h${i}`, email: `a${i}@x.com`, company_hubspot_id: i % 2 ? "c1" : null,
      synced_at: "2026-11-05T08:00:00Z", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-11-05T08:00:00Z",
    }));
    const s = sub({ dataset: "compplan.hubspot_contacts", app: "compplan", records: recs, authoritative: { h0: { email: "a0@x.com" }, h1: { email: "a1@x.com" } }, references: { hubspot_companies: ["c1"] } });
    const r = evaluate(spec, s, buildBaseline(spec, recs), DEFAULT_POLICY, NOW);
    expect(r.dimensions.find((d) => d.id === "consistency")?.state).toBe("not_applicable");
    expect(r.dimensions.find((d) => d.id === "accuracy")?.state).toBe("scored");
    expect(r.score).toBe(100);
    expect(r.status).toBe("Excellent");
    // Without HubSpot values to compare, accuracy is UNVERIFIED and the run has too little evidence for a score.
    const noAuth = evaluate(spec, { ...s, authoritative: undefined }, buildBaseline(spec, recs), DEFAULT_POLICY, NOW);
    expect(noAuth.status).toBe("UNVERIFIED");
    // First run, no baseline: change integrity (3 of 90) is UNVERIFIED and counts 0, so 96.7 not 100.
    expect(evaluate(spec, s, null, DEFAULT_POLICY, NOW).score).toBe(96.7);
    // A link to a company that does not exist is critical.
    const bad = evaluate(spec, { ...s, references: { hubspot_companies: ["other"] } }, buildBaseline(spec, recs), DEFAULT_POLICY, NOW);
    expect(bad.critical).toBe(true);
  });
});

describe("Database column on the Health dashboard", () => {
  it("is measured from the newest data quality check of the app's tables", async () => {
    const { databaseScore } = await import("../server/health/score.js");
    const db = freshDb();
    expect(databaseScore(db, "test.example.com")).toBeNull();
    const r = validateRefresh(db, sub(), DEFAULT_POLICY, NOW);
    const s = databaseScore(db, "test.example.com")!;
    expect(s.source).toBe("measured");
    expect(s.score).toBe(r.score);
    expect(s.evidence.join(" ")).toContain("test.people");
    expect(databaseScore(db, "other.example.com")).toBeNull();
  });
  it("gives no number when the only check could not be verified", async () => {
    const { databaseScore } = await import("../server/health/score.js");
    const db = freshDb();
    validateRefresh(db, sub({ sourceReached: false }), DEFAULT_POLICY, NOW);
    expect(databaseScore(db, "test.example.com")).toBeNull();
  });
});

describe("10bonds dataset specs", () => {
  const bonds = (n = 600) =>
    Array.from({ length: n }, (_, i) => ({
      isin: `XS${String(i).padStart(9, "0")}5`, name: `Bond ${i}`, issuer: `Issuer ${i % 50}`, currency: "EUR",
      coupon: 3, maturity: "2031-06-01", gross_ytm: 3.5, modified_duration: 4.2, years_to_maturity: 4.6,
      ytm_as_of: "2026-11-05T06:00:00Z", source: "lm-op-model", fetched_at: "2026-11-05T09:59:00Z",
    }));
  const tenbonds = (dataset: string, records: Row[], over: Partial<RefreshSubmission> = {}) =>
    sub({ app: "10bonds", dataset, kind: "sync", records, authoritative: undefined, references: undefined, ...over });

  it("public_bonds: a clean copy scores Good or better on the first run, a broken one fails", async () => {
    const { getSpec } = await import("../server/quality/datasets/index.js");
    const spec = getSpec("10bonds.public_bonds")!;
    const recs = bonds();
    const first = evaluate(spec, tenbonds(spec.id, recs), null, DEFAULT_POLICY, NOW);
    expect(first.outcome).toBe("PASS");
    expect(first.score).toBeGreaterThanOrEqual(95);
    expect(evaluate(spec, tenbonds(spec.id, recs), buildBaseline(spec, recs), DEFAULT_POLICY, NOW).score).toBe(100);
    // Duplicate ISIN or a copy that shrank to almost nothing is critical.
    expect(evaluate(spec, tenbonds(spec.id, [...recs, recs[0]!]), null, DEFAULT_POLICY, NOW).critical).toBe(true);
    expect(evaluate(spec, tenbonds(spec.id, recs.slice(0, 20)), null, DEFAULT_POLICY, NOW).critical).toBe(true);
    // Yields 10 days old: freshness drops.
    const stale = recs.map((r) => ({ ...r, ytm_as_of: "2026-10-26T06:00:00Z" }));
    expect(evaluate(spec, tenbonds(spec.id, stale), null, DEFAULT_POLICY, NOW).dimensions.find((d) => d.id === "freshness")!.score).toBeLessThan(100);
  });

  it("best_bonds: checks links and values against the bond copy", async () => {
    const { getSpec } = await import("../server/quality/datasets/index.js");
    const spec = getSpec("10bonds.best_bonds")!;
    const copy = bonds(50);
    const recs = copy.slice(0, 20).map((b, i) => ({
      duration: 5, level: (i % 10) + 1, rank: Math.floor(i / 10) + 1, isin: b.isin, gross_ytm: 3.5, modified_duration: 4.2,
      loss_adjusted_yield: 3.3, as_of: "2026-11-05T06:00:00Z", source: "public.public_bonds",
    }));
    const k = (r: Row) => `${r.duration}|${r.level}|${r.isin}`;
    const authoritative = Object.fromEntries(recs.map((r) => [k(r), { gross_ytm: 3.5, modified_duration: 4.2 }]));
    const s = tenbonds(spec.id, recs, { kind: "recompute", sourceReached: true, references: { public_bonds: copy.map((b) => b.isin) }, authoritative });
    const r = evaluate(spec, s, buildBaseline(spec, recs), DEFAULT_POLICY, NOW);
    expect(r.score).toBe(100);
    // A ranked bond missing from the copy is a broken link (critical).
    expect(evaluate(spec, { ...s, references: { public_bonds: [] } }, null, DEFAULT_POLICY, NOW).critical).toBe(true);
    // A stale cached yield shows as an accuracy mismatch.
    const wrong = { ...authoritative, [k(recs[0]!)]: { gross_ytm: 9, modified_duration: 4.2 } };
    expect(evaluate(spec, { ...s, authoritative: wrong }, null, DEFAULT_POLICY, NOW).dimensions.find((d) => d.id === "accuracy")!.score).toBeLessThan(100);
  });
});

describe("per-app quality keys", () => {
  const KEY = "k".repeat(30);
  const mk = () => createApp(freshDb(), { apiToken: "main-token", qualityTokens: `10bonds=${KEY}, bad=short` });
  const body = (over: Partial<RefreshSubmission> = {}) => sub({ app: "10bonds", dataset: "10bonds.unknown", ...over });

  it("lets an app send its own data checks and nothing else", async () => {
    const app = mk();
    const auth = { authorization: `Bearer ${KEY}` };
    expect((await request(app).post("/api/quality/validate").set(auth).send(body())).status).toBe(200);
    // Another app's name: refused.
    expect((await request(app).post("/api/quality/validate").set(auth).send(body({ app: "compplan" }))).status).toBe(403);
    // Any other route, reads included: refused.
    expect((await request(app).get("/api/quality/summary").set(auth)).status).toBe(401);
    expect((await request(app).get("/api/allowlist").set(auth)).status).toBe(401);
    // A key shorter than 24 characters is ignored.
    expect((await request(app).post("/api/quality/validate").set({ authorization: "Bearer short" }).send(body())).status).toBe(401);
    // The main token still works for everything.
    expect((await request(app).get("/api/quality/summary").set({ authorization: "Bearer main-token" })).status).toBe(200);
  });
});

describe("lm-op-model dataset specs", () => {
  const quote = (i: number) => ({
    isin: `DE000A${String(i).padStart(5, "0")}0`, price: 98.5 + (i % 5), price_source: "Börse Frankfurt",
    price_updated_at: "2026-11-05T08:00:00Z", ytm: 3.1, ytm_source: "Borsa Italiana", low_52: 95, high_52: 101,
  });
  const quotes = Array.from({ length: 60 }, (_, i) => quote(i));
  const catalogue = quotes.map((q) => q.isin);

  it("bond_quotes: a clean price run with a baseline scores 100", async () => {
    const { getSpec } = await import("../server/quality/datasets/index.js");
    const spec = getSpec("lm-op-model.bond_quotes")!;
    const s = sub({ app: "lm-op-model", dataset: "lm-op-model.bond_quotes", records: quotes, references: { bond_catalogue: catalogue }, authoritative: undefined });
    const r = evaluate(spec, s, buildBaseline(spec, quotes), DEFAULT_POLICY, NOW);
    expect(r.dimensions.find((d) => d.id === "accuracy")?.state).toBe("not_applicable");
    expect(r.score).toBe(100);
    // New prices on every bond are normal in a price run, not a mass overwrite.
    const moved = quotes.map((q) => ({ ...q, price: q.price + 0.4 }));
    expect(evaluate(spec, { ...s, records: moved }, buildBaseline(spec, quotes), DEFAULT_POLICY, NOW).score).toBe(100);
  });

  it("bond_quotes: a price for a bond the app does not know is critical; a yield read as a price is invalid", async () => {
    const { getSpec } = await import("../server/quality/datasets/index.js");
    const spec = getSpec("lm-op-model.bond_quotes")!;
    const s = sub({ app: "lm-op-model", dataset: "lm-op-model.bond_quotes", records: quotes, references: { bond_catalogue: catalogue.slice(1) }, authoritative: undefined });
    expect(evaluate(spec, s, buildBaseline(spec, quotes), DEFAULT_POLICY, NOW).critical).toBe(true);
    const bad = quotes.map((q, i) => (i < 6 ? { ...q, price: 450 } : q));
    const r = evaluate(spec, { ...s, records: bad, references: { bond_catalogue: catalogue } }, buildBaseline(spec, quotes), DEFAULT_POLICY, NOW);
    expect(r.issues.some((i) => i.code === "invalid_price")).toBe(true);
    expect(r.score).toBeLessThan(100);
  });

  it("bond_quotes: prices older than the limit lose freshness", async () => {
    const { getSpec } = await import("../server/quality/datasets/index.js");
    const spec = getSpec("lm-op-model.bond_quotes")!;
    const old = quotes.map((q) => ({ ...q, price_updated_at: "2026-11-02T08:00:00Z" }));
    const s = sub({ app: "lm-op-model", dataset: "lm-op-model.bond_quotes", records: old, references: { bond_catalogue: catalogue }, authoritative: undefined });
    const r = evaluate(spec, s, buildBaseline(spec, old), DEFAULT_POLICY, NOW);
    expect(r.issues.some((i) => i.code === "stale")).toBe(true);
  });

  it("bond_explorer_bonds: a clean catalogue (recompute, no source) still gets a score", async () => {
    const { getSpec } = await import("../server/quality/datasets/index.js");
    const spec = getSpec("lm-op-model.bond_explorer_bonds")!;
    const cat = Array.from({ length: 120 }, (_, i) => ({
      isin: `XS${String(i).padStart(9, "0")}1`, name: `Bond ${i}`, currency: "EUR", type: i % 2 ? "corporate" : "government",
      coupon: 2.5, maturity: "2030-06-01T00:00:00.000Z", issue_date: "2020-06-01T00:00:00.000Z", price: 99, source: "Deutsche Börse import",
    }));
    const s = sub({ app: "lm-op-model", dataset: "lm-op-model.bond_explorer_bonds", kind: "recompute", sourceReached: null, records: cat, references: undefined, authoritative: undefined });
    const r = evaluate(spec, s, buildBaseline(spec, cat), DEFAULT_POLICY, NOW);
    expect(r.outcome).toBe("PASS");
    expect(r.score).toBe(100);
    const dup = evaluate(spec, { ...s, records: [...cat, cat[0]!] }, buildBaseline(spec, cat), DEFAULT_POLICY, NOW);
    expect(dup.critical).toBe(true);
  });
});
