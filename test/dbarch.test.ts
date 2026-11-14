import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.js";
import { freshDb } from "./helpers.js";
import { FakePg, sampleTables, type FakeTable } from "./dbarch-fake.js";
import { runAll, runScan, checkStaleness, deriveAlerts, type Deps, type AppResult } from "../server/dbarch/engine.js";
import { ConnectError } from "../server/dbarch/connect.js";
import { engage } from "../server/governance/killswitch.js";
import { assertReadOnlySql, ReadOnlyViolation } from "../server/dbarch/readonly.js";
import { CLASSIFIED } from "../server/dbarch/registry.js";
import { fkDraft, lintDraftSql } from "../server/dbarch/recommendations.js";
import { scoreArchitecture, overallFrom, type Evidence } from "../server/dbarch/scoring.js";
import { readNeonSettings } from "../server/dbarch/neon.js";
import { buildView } from "../server/dbarch/view.js";
import { getLatest, addAttestation, recentScans } from "../server/dbarch/store.js";
import { STALE_AFTER_MS } from "../server/dbarch/apps.js";
import type { DB } from "../server/db.js";
import type { AppKey } from "../server/dbarch/types.js";

const ENV = { SECVAL_DBARCH_URL_ATLAS: "fake://a", SECVAL_DBARCH_URL_LM_OP_MODEL: "fake://l", SECVAL_DBARCH_URL_NEXUS: "fake://n" };
const T0 = new Date("2026-11-05T12:00:00Z");

interface Rig { deps: Deps; dbs: Map<string, FakePg>; clock: { t: Date }; fail: Set<string> }
function rig(tablesFor: (app: AppKey) => FakeTable[] = () => sampleTables(), env: Record<string, string | undefined> = ENV): Rig {
  const dbs = new Map<string, FakePg>();
  const clock = { t: T0 };
  const fail = new Set<string>();
  const deps: Deps = {
    env,
    now: () => clock.t,
    connect: async (cs) => {
      const app = (cs === "fake://a" ? "atlas" : cs === "fake://l" ? "lm-op-model" : "nexus") as AppKey;
      if (fail.has(app)) throw new ConnectError("could not open a read-only session");
      const pg = new FakePg(tablesFor(app));
      dbs.set(app, pg);
      return pg;
    },
    neonFetch: async (url) => ({
      ok: true, status: 200,
      json: async () => url.endsWith("/branches")
        ? { branches: [{ id: "br-1", name: "main", default: true, protected: false }] }
        : { project: { history_retention_seconds: 21600 } },
    }),
  };
  return { deps, dbs, clock, fail };
}
const advance = (r: Rig, ms: number) => { r.clock.t = new Date(r.clock.t.getTime() + ms); };
const withRegistry = (app: AppKey, entries: typeof CLASSIFIED["atlas"], fn: () => Promise<void> | void) => async () => {
  const before = CLASSIFIED[app].slice();
  CLASSIFIED[app].push(...entries);
  try { await fn(); } finally { CLASSIFIED[app].splice(0, CLASSIFIED[app].length, ...before); }
};

describe("dbarch: read-only guard", () => {
  it("refuses anything that could write", () => {
    for (const bad of ["DELETE FROM x", "UPDATE x SET a=1", "INSERT INTO x VALUES (1)", "DROP TABLE x", "SELECT 1; DROP TABLE x", "WITH a AS (DELETE FROM x RETURNING *) SELECT * FROM a", "SELECT * FROM x FOR UPDATE", "CREATE INDEX i ON x(a)", "TRUNCATE x", "ALTER TABLE x ADD y int", "COPY x TO '/tmp/a'"]) {
      expect(() => assertReadOnlySql(bad), bad).toThrow(ReadOnlyViolation);
    }
    expect(() => assertReadOnlySql("SELECT 'update' AS word")).not.toThrow();
    expect(() => assertReadOnlySql("WITH a AS (SELECT 1) SELECT * FROM a")).not.toThrow();
  });
});

describe("dbarch: scan scenarios (fixtures, no live database)", () => {
  let db: DB;
  beforeEach(() => { db = freshDb(); });

  it("1. connects three databases and every statement sent was read-only", async () => {
    const r = rig();
    const out = await runAll(db, "deep", r.deps);
    expect(out.map((o) => o.status)).toEqual(["partial", "partial", "partial"]); // partial: no human attestations yet
    expect(r.dbs.size).toBe(3);
    for (const pg of r.dbs.values()) {
      expect(pg.log.length).toBeGreaterThan(8);
      for (const sql of pg.log.filter((q) => !/SAVEPOINT/.test(q))) expect(() => assertReadOnlySql(sql)).not.toThrow(); // 12. no modifications possible (SAVEPOINT is session control, not data access)
      expect(pg.closed).toBe(true);
    }
    const v = buildView(db, ENV, r.clock.t);
    expect(v.apps.map((a) => a.app)).toEqual(["atlas", "lm-op-model", "nexus"]);
    for (const a of v.apps) expect(a.headline.architecture.score).not.toBeNull();
  });

  it("2. one unavailable app does not hide the others and shows ERROR without leaking details", async () => {
    const r = rig();
    await runAll(db, "deep", r.deps);
    advance(r, 3_600_000);
    r.fail.add("nexus");
    const out = await runAll(db, "deep", r.deps);
    expect(out[2]).toEqual({ app: "nexus", status: "error", message: "could not open a read-only session" });
    const v = buildView(db, ENV, r.clock.t);
    expect(v.apps[2]!.headline.architecture.state).toBe("ERROR");
    expect(v.apps[2]!.lastError).toBe("could not open a read-only session");
    expect(v.apps[0]!.headline.architecture.state).not.toBe("ERROR");
    expect(JSON.stringify(v)).not.toContain("fake://");
  });

  it("3. a classified missing foreign key becomes a recommendation with a safe draft migration", withRegistry("atlas", [{ column: "projects.client_id", classification: "mandatory", evidence: "code review: every project belongs to a client" }], async () => {
    const r = rig();
    await runScan(db, "atlas", "deep", r.deps);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    const rec = d.recommendations.find((x) => x.id === "fk:projects.client_id")!;
    expect(rec.draftSql).toContain('FOREIGN KEY ("client_id") REFERENCES "clients" ("id") NOT VALID');
    expect(lintDraftSql(rec.draftSql!).ok).toBe(true);
    expect(rec.priority).toBe("P1");
    for (const f of ["issue", "target", "evidence", "rootCause", "correction", "expectedImprovement", "riskEffort", "migrationOrCode", "verificationTest", "rollback", "owner"] as const) expect(rec[f]).toBeTruthy();
    const fk = d.architecture.criteria.find((c) => c.key === "fk")!;
    expect(fk.score).toBeLessThan(10);
  }));

  it("4. a genuine orphan on a classified relationship FAILS, is P0/P1, raises an alert and caps the criterion", withRegistry("atlas", [{ column: "projects.client_id", classification: "mandatory", evidence: "reviewed" }], async () => {
    const r = rig(() => sampleTables({ orphan: true }));
    await runScan(db, "atlas", "deep", r.deps);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    const c = d.checks.find((x) => x.checkId === "orph:projects.client_id")!;
    expect(c.outcome).toBe("FAIL");
    expect(c.failures).toBe(1);
    expect(c.severity).toBe("P0"); // projects is a priority table for ATLAS
    expect(d.architecture.criteria.find((x) => x.key === "orphans")!.score).toBeLessThanOrEqual(4);
    const alerts = db.prepare(`SELECT kind FROM dbarch_alerts WHERE app='atlas'`).all() as Array<{ kind: string }>;
    expect(alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(["new-orphans", "critical-integrity"]));
    expect(d.inventory.find((i) => i.sourceColumn === "client_id")!.orphans).toBe(1);
  }));

  it("4b. the same orphan on an UNCLASSIFIED column is reported but is not a verified defect", async () => {
    const r = rig(() => sampleTables({ orphan: true }));
    await runScan(db, "atlas", "deep", r.deps);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    const c = d.checks.find((x) => x.checkId === "orph:projects.client_id")!;
    expect(c.outcome).toBe("UNVERIFIED");
    expect(c.severity).toBe("P3");
    expect(db.prepare(`SELECT count(*) AS n FROM dbarch_alerts`).get()).toEqual({ n: expect.any(Number) });
    expect((db.prepare(`SELECT kind FROM dbarch_alerts WHERE kind IN ('new-orphans','critical-integrity')`).all() as unknown[]).length).toBe(0);
  });

  it("5. a legitimate external id without a foreign key produces no check and no finding", withRegistry("atlas", [{ column: "projects.stripe_customer_id", classification: "external", evidence: "Stripe id, not a table" }], async () => {
    const r = rig();
    await runScan(db, "atlas", "deep", r.deps);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    expect(d.inventory.find((i) => i.sourceColumn === "stripe_customer_id")!.classification).toBe("external");
    expect(d.checks.some((c) => c.checkId.includes("stripe_customer_id"))).toBe(false);
    expect(d.recommendations.some((x) => x.id.includes("stripe_customer_id"))).toBe(false);
  }));

  it("an _id column is never called a missing FK from its name alone", async () => {
    const r = rig();
    await runScan(db, "atlas", "deep", r.deps);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    expect(d.inventory.every((i) => i.classification === "UNVERIFIED")).toBe(true);
    expect(d.recommendations.some((x) => x.id.startsWith("fk:"))).toBe(false);
  });

  it("6. a repeated click is deduplicated and a failed scan never replaces the last good result", async () => {
    const r = rig();
    const a = await runScan(db, "atlas", "quick", r.deps);
    const b = await runScan(db, "atlas", "quick", r.deps);
    expect(a.status).not.toBe("skipped");
    expect(b.status).toBe("skipped");
    expect(recentScans(db, "atlas").length).toBe(1);
    advance(r, 120_000);
    r.fail.add("atlas");
    await runScan(db, "atlas", "quick", r.deps);
    expect(recentScans(db, "atlas").map((s) => s.status)).toEqual(["error", expect.stringMatching(/ok|partial/)]);
    expect(getLatest(db, "atlas")!.result).toBeTruthy();
  });

  it("3 repeated failures raise one scan-failure alert", async () => {
    const r = rig();
    r.fail.add("atlas");
    for (let i = 0; i < 4; i++) { await runScan(db, "atlas", "quick", r.deps); advance(r, 120_000); }
    expect((db.prepare(`SELECT count(*) AS n FROM dbarch_alerts WHERE kind='scan-failures'`).get() as { n: number }).n).toBe(1);
  });

  it("7+11. a changed score is compared with the previous verified snapshot", async () => {
    let tables = sampleTables();
    const r = rig(() => tables);
    await runScan(db, "atlas", "deep", r.deps);
    const first = buildView(db, ENV, r.clock.t).apps[0]!;
    expect(first.headline.architecture.previous).toBeNull();
    advance(r, 6 * 3_600_000);
    tables = tables.map((t) => (t.name === "scratch" ? { ...t, pk: "note" } : t)); // scratch gets a primary key: PK coverage improves
    await runScan(db, "atlas", "deep", r.deps);
    const second = buildView(db, ENV, r.clock.t).apps[0]!;
    const pk = second.architectureCriteria.find((c) => c.key === "pk")!;
    expect(pk.previous).toBe(8);
    expect(pk.measured).toBe(10);
    expect(pk.delta).toBe(2);
    expect(second.headline.architecture.previous).toBe(first.headline.architecture.score);
    expect(second.history.length).toBe(2);
    expect(second.schemaChange).toBe("changed"); // unacknowledged change since baseline
    expect((db.prepare(`SELECT kind FROM dbarch_alerts WHERE kind='unapproved-schema-change'`).all() as unknown[]).length).toBe(1);
  });

  it("8. unmeasured inputs are N/V or PARTIAL, never a verified zero", async () => {
    const r = rig(() => sampleTables(), { ...ENV });
    r.deps.neonFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await runScan(db, "atlas", "deep", { ...r.deps, env: { ...ENV, SECVAL_NEON_API_TOKEN: "x" } });
    const a = buildView(db, ENV, r.clock.t).apps[0]!;
    const backup = a.architectureCriteria.find((c) => c.key === "backup")!;
    expect(backup.subscores.filter((s) => s.earned === null).length).toBe(3);
    expect(backup.measured).toBeNull();
    expect(backup.state).toBe("UNVERIFIED");
    expect(a.headline.architecture.state).toBe("PARTIAL");
  });

  it("an app with no connection configured shows N/V and no scan row", async () => {
    const r = rig(undefined, { SECVAL_DBARCH_URL_ATLAS: "fake://a" });
    const out = await runAll(db, "quick", r.deps);
    expect(out[1]!.status).toBe("unconfigured");
    const v = buildView(db, r.deps.env, r.clock.t);
    expect(v.apps[1]!.headline.architecture.score).toBeNull();
    expect(v.apps[1]!.headline.architecture.state).toBe("UNVERIFIED");
    expect(recentScans(db, "lm-op-model").length).toBe(0);
  });

  it("9. an old result is STALE and raises one stale alert", async () => {
    const r = rig();
    await runScan(db, "atlas", "deep", r.deps);
    advance(r, STALE_AFTER_MS + 60_000);
    expect(buildView(db, ENV, r.clock.t).apps[0]!.headline.architecture.state).toBe("STALE");
    checkStaleness(db, r.deps, STALE_AFTER_MS);
    checkStaleness(db, r.deps, STALE_AFTER_MS);
    expect((db.prepare(`SELECT count(*) AS n FROM dbarch_alerts WHERE kind='stale'`).get() as { n: number }).n).toBe(1);
  });

  it("10. a score drop, lost FK and disabled branch protection raise alerts", () => {
    const base = { app: "atlas", checks: [], architecture: { score: 6 }, catalog: { foreignKeys: 5, primaryKeys: 10 }, neon: { protected: true, historyRetentionSeconds: 7 * 86400 }, schemaChange: "unchanged" } as unknown as AppResult;
    const cur = { ...base, architecture: { score: 5.2 }, catalog: { foreignKeys: 4, primaryKeys: 9 }, neon: { protected: false, historyRetentionSeconds: 6 * 3600 } } as unknown as AppResult;
    const kinds = deriveAlerts("atlas", cur, base, 6).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["fk-lost", "pk-lost", "branch-protection-off", "recovery-below-threshold", "score-drop"]));
  });

  it("a quick refresh carries a recent deep audit's orphan results forward", withRegistry("atlas", [{ column: "projects.client_id", classification: "mandatory", evidence: "reviewed" }], async () => {
    const tables = sampleTables({ orphan: true });
    tables[1]!.estRows = 900_000; // too big for the quick budget, so only a deep audit can examine it
    const r = rig(() => tables);
    await runScan(db, "atlas", "deep", r.deps);
    advance(r, 6 * 3_600_000);
    await runScan(db, "atlas", "quick", r.deps);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    const c = d.checks.find((x) => x.checkId === "orph:projects.client_id")!;
    expect(c.outcome).toBe("FAIL");
    expect(c.evidence).toContain("from deep audit");
  }));

  it("the total-time budget stops new checks and says so", async () => {
    const tables = sampleTables();
    const r = rig(() => tables);
    let calls = 0;
    r.deps.now = () => new Date(T0.getTime() + (calls++ > 40 ? 400_000 : 0)); // the clock jumps past the 300 s deep budget mid-scan
    await runScan(db, "atlas", "deep", r.deps);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    expect(d.checks.every((c) => c.outcome === "PASS" || c.evidence.includes("time budget"))).toBe(true);
  });

  it("attestations are time-bound, visible and never overwrite the measured value", async () => {
    const r = rig();
    await runScan(db, "atlas", "deep", r.deps);
    addAttestation(db, { app: "atlas", key: "override:a_pk", value: 9, reason: "Reviewed by hand", approvedBy: "operator", expiresAt: new Date(r.clock.t.getTime() + 86_400_000).toISOString() }, r.clock.t.toISOString());
    let pk = buildView(db, ENV, r.clock.t).apps[0]!.architectureCriteria.find((c) => c.key === "pk")!;
    expect(pk.measured).toBe(8);
    expect(pk.effective).toBe(9);
    expect(pk.override?.reason).toBe("Reviewed by hand");
    advance(r, 2 * 86_400_000);
    pk = buildView(db, ENV, r.clock.t).apps[0]!.architectureCriteria.find((c) => c.key === "pk")!;
    expect(pk.override).toBeNull();
    expect(pk.effective).toBe(pk.measured);
  });

  it("readiness is capped at 8 until an independent verification is recorded", async () => {
    const r = rig();
    await runScan(db, "atlas", "deep", r.deps);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    for (const row of d.readiness.rows) if (row.score !== null) expect(row.score).toBeLessThanOrEqual(8);
    expect(d.readiness.rows.some((x) => x.capReason)).toBe(true);
  });
});

describe("dbarch: scoring is deterministic and reproducible by hand", () => {
  const ev = (over: Partial<Evidence>): Evidence => ({
    cat: {
      collectedAt: "x", tables: [1, 2, 3, 4].map((n) => ({ name: `t${n}`, estRows: 10, columns: ["id", "created_at"], hasPrimaryKey: n <= 3 })),
      columns: [], foreignKeys: [], indexes: [], constraints: [], triggers: [], rlsEnabledTables: [], publicGrantTables: [], migrationLedgers: [], migrationLatest: null, migrationLedgerColumn: null, sessionReadOnly: true,
    },
    inventory: [], checksDefined: 0, checks: [], neon: { branchName: "main", branchId: "b", protected: false, historyRetentionSeconds: 6 * 3600 }, schemaChange: "first", deepAuditAgeHours: null,
    attest: { authzReview: null, restoreTest: null, independentlyVerified: false }, recommendationsTotal: 0, recommendationsComplete: 0, draftsTotal: 0, draftsSafe: 0, needsMigration: 0, hasPrevious: false, permissions: null, ...over,
  });
  it("hand-computed criteria", () => {
    const c = Object.fromEntries(scoreArchitecture(ev({})).map((x) => [x.key, x]));
    expect(c.pk!.score).toBe(7.5); // 10 x 3/4
    expect(c.backup!.subscores.find((s) => s.key === "retention")!.earned).toBe(0.18); // 5 x 6/168 rounded to 2dp
    expect(c.backup!.subscores.find((s) => s.key === "branch_prot")!.earned).toBe(0); // measured, not protected
    expect(c.migrations!.subscores.find((s) => s.key === "drift")!.earned).toBeNull(); // first scan: N/V
    expect(c.security!.score).toBeNull(); // 4/10 measured -> coverage 0.4 < 0.5 -> N/V, not a number
  });
  it("overall counts unmeasured criteria as zero and reports coverage", () => {
    const o = overallFrom(scoreArchitecture(ev({})));
    expect(o.coverage).toBeLessThan(1);
    expect(o.state).toBe("PARTIAL");
  });
  it("RLS being off is not penalised", () => {
    const a = scoreArchitecture(ev({}));
    const b = scoreArchitecture(ev({ cat: { ...ev({}).cat!, rlsEnabledTables: ["t1"] } }));
    expect(a.find((x) => x.key === "security")!.subscores.map((s) => s.earned)).toEqual(b.find((x) => x.key === "security")!.subscores.map((s) => s.earned));
  });
});

describe("dbarch: draft SQL safety and Neon reads", () => {
  it("lint rejects destructive forward statements and missing rollback", () => {
    expect(lintDraftSql("DELETE FROM x;\n-- VERIFY\n-- ROLLBACK\nselect 1").ok).toBe(false);
    expect(lintDraftSql("ALTER TABLE a ADD CONSTRAINT b FOREIGN KEY (c) REFERENCES d (e);").ok).toBe(false);
    expect(fkDraft({ sourceTable: "a", sourceColumn: "b_id", targetTable: "b", targetColumn: "id", targetAmbiguous: false, cardinality: "many-to-one", classification: "mandatory", evidence: "", orphans: 0, rowsExamined: 0, criticality: "high", recommendedAction: "" })).toContain("NOT VALID");
    expect(fkDraft({ sourceTable: "a", sourceColumn: "b_id", targetTable: "b", targetColumn: "id", targetAmbiguous: false, cardinality: "many-to-one", classification: "UNVERIFIED", evidence: "", orphans: null, rowsExamined: null, criticality: "high", recommendedAction: "" })).toBeNull();
  });
  it("Neon settings come only from GET and are N/V without a token", async () => {
    expect(await readNeonSettings("p", undefined)).toBeNull();
    const calls: string[] = [];
    const s = await readNeonSettings("autumn-sun-22098033", "t", async (url, init) => {
      calls.push(url + ((init as { method?: string })?.method ?? "GET"));
      return { ok: true, status: 200, json: async () => (url.endsWith("/branches") ? { branches: [{ id: "b1", name: "production", default: true, protected: true }] } : { project: { history_retention_seconds: 604800 } }) };
    });
    expect(s).toEqual({ branchName: "production", branchId: "b1", protected: true, historyRetentionSeconds: 604800 });
    expect(calls.every((c) => c.endsWith("GET"))).toBe(true);
  });
});

describe("dbarch: HTTP API", () => {
  const TOKEN = "t0k";
  const auth = { Authorization: `Bearer ${TOKEN}` };
  it("requires the token, refreshes, and never returns connection strings or SQL", async () => {
    const db = freshDb();
    const r = rig();
    const app = createApp(db, { apiToken: TOKEN, dbarch: r.deps });
    expect((await request(app).get("/api/dbarch")).status).toBe(401);
    const empty = await request(app).get("/api/dbarch").set(auth);
    expect(empty.body.apps[0].headline.architecture.score).toBeNull();
    const res = await request(app).post("/api/dbarch/refresh").set(auth).send({ mode: "deep" });
    expect(res.status).toBe(200);
    expect(res.body.view.apps[0].headline.architecture.score).not.toBeNull();
    const detail = await request(app).get("/api/dbarch/atlas/detail").set(auth);
    const blob = JSON.stringify(res.body) + JSON.stringify(detail.body);
    expect(blob).not.toContain("fake://");
    expect(blob).not.toMatch(/SELECT\s.+\sFROM\s/);
    expect((await request(app).post("/api/dbarch/refresh").set(auth).send({ mode: "bogus" })).status).toBe(400);
    const att = await request(app).post("/api/dbarch/attest").set(auth).send({ app: "atlas", key: "authz_review", value: 7, reason: "Reviewed the access-control design", expiresInDays: 30 });
    expect(att.status).toBe(201);
    expect((await request(app).post("/api/dbarch/attest").set(auth).send({ app: "atlas", key: "evil", reason: "xxxxxx", expiresInDays: 1 })).status).toBe(400);
  });
  it("the Refresh button endpoint also starts a quick database refresh", async () => {
    const db = freshDb();
    const r = rig();
    const app = createApp(db, { apiToken: TOKEN, dbarch: r.deps });
    await request(app).post("/api/dashboard/check-now").set(auth).send({});
    await new Promise((res) => setTimeout(res, 100));
    expect(recentScans(db, "atlas").length).toBe(1);
  });
});

// Optional: the same collectors against a REAL scratch Postgres (never a monitored database).
// Run with SECVAL_TEST_PG_URL=postgres://... after loading test/fixtures/dbarch-schema.sql.
import { pgConnector } from "../server/dbarch/connect.js";
import { collectCatalog } from "../server/dbarch/catalog.js";
import { buildInventory } from "../server/dbarch/inventory.js";
import { buildChecks, runChecks } from "../server/dbarch/checks.js";
describe.skipIf(!process.env.SECVAL_TEST_PG_URL)("dbarch: real Postgres catalog (scratch database)", () => {
  it("reads metadata, finds the planted orphan and stays read-only", async () => {
    const s = await pgConnector(process.env.SECVAL_TEST_PG_URL!);
    try {
      const cat = await collectCatalog(s);
      expect(cat.sessionReadOnly).toBe(true);
      expect(cat.tables.find((t) => t.name === "notes")!.hasPrimaryKey).toBe(false);
      expect(cat.foreignKeys.map((f) => f.columns)).toEqual([["client_id"]]);
      const inv = buildInventory("atlas", cat);
      const res = await runChecks(s, cat, buildChecks("atlas", cat, inv), { tier: "deep" });
      expect(res.find((r) => r.checkId === "orph:projects.client_id")!.failures).toBe(1);
      await expect(s.query("DELETE FROM clients")).rejects.toThrow(); // server-side read-only session also refuses writes
    } finally { await s.close(); }
  });
});

// Real Postgres, real least-privilege role built from docs/sql/dbarch-monitor-role.sql (the exact script Livio will run).
import { readFileSync } from "node:fs";
import pgLib from "pg";
import { verifyPermissions } from "../server/dbarch/permissions.js";
import { isolated } from "../server/dbarch/readonly.js";
import { grantsSql, requiredGrants } from "../server/dbarch/grants.js";
import { assertTlsRequired } from "../server/dbarch/connect.js";
import { testConnectivity } from "../server/dbarch/connectivity.js";
describe.skipIf(!process.env.SECVAL_TEST_PG_URL)("dbarch: least-privilege role on a real Postgres", () => {
  const admin = process.env.SECVAL_TEST_PG_URL!;
  const as = (user: string) => { const u = new URL(admin); u.username = user; u.password = "pw"; return u.toString(); };
  const dbName = () => new URL(admin).pathname.slice(1);
  async function run(sql: string) { const c = new pgLib.Client({ connectionString: admin }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }
  const reset = async () => {
    await run("REVOKE ALL ON notes FROM PUBLIC"); // the fixture's planted PUBLIC grant is tested separately below
    await run("DROP OWNED BY secval_monitor").catch(() => undefined);
    await run("DROP ROLE IF EXISTS secval_monitor");
    const owner = new URL(admin).username;
    await run(readFileSync("docs/sql/dbarch-monitor-role.sql", "utf8").replace("<PASSWORD>", "pw").replaceAll("<DB_NAME>", dbName()).replace("<OWNER_ROLE>", owner));
  };
  const deps = (user: string): Deps => ({ env: { SECVAL_DBARCH_URL_ATLAS: as(user) }, now: () => new Date(), connect: pgConnector });

  it("step 1 (metadata only): passes every permission check, reads no data, cannot write", async () => {
    await reset();
    const s = await pgConnector(as("secval_monitor"));
    try {
      const rep = await verifyPermissions(s);
      expect(rep.checks.filter((c) => c.ok === false && c.id !== "tls")).toEqual([]); // local scratch server has no TLS; production TLS is enforced by the client
      expect(rep.leastPrivilege).toBe(true);
      expect(rep.readableColumns).toBe(0);
      const cat = await collectCatalog(s);
      expect(cat.tables.length).toBeGreaterThan(3); // metadata visible with no table privilege
      expect(cat.columns.length).toBeGreaterThan(10);
      expect(cat.publicGrantTables).toEqual([]);
      await expect(s.query("SELECT count(*) FROM clients")).rejects.toThrow(/permission denied/); // no data access at all
    } finally { await s.close(); }
    const s2 = await pgConnector(as("secval_monitor"));
    try { await expect(s2.query("DELETE FROM clients")).rejects.toThrow(/read-only|permission denied/); } finally { await s2.close(); }
  });

  it("scan before grants: metadata scores work, orphan checks say N/V because of least privilege", async () => {
    await reset();
    const db = freshDb();
    const out = await runScan(db, "atlas", "deep", deps("secval_monitor"));
    expect(out.status).toBe("partial");
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    expect(d.catalog.tables).toBeGreaterThan(3);
    expect(d.checks.length).toBeGreaterThan(0);
    expect(d.checks.every((c) => c.outcome === "UNVERIFIED" && c.evidence.includes("No SELECT grant"))).toBe(true);
    expect(d.grants.columns).toContain("projects.client_id");
    expect(d.grants.columns).toContain("clients.id");
  });

  it("step 2: the generated column grants enable the checks and the planted orphan is found; still read-only", async () => {
    await reset();
    const db = freshDb();
    await runScan(db, "atlas", "deep", deps("secval_monitor"));
    const g = (getLatest(db, "atlas")!.result as unknown as AppResult).grants;
    const sql = grantsSql(g, "2026-11-05");
    expect(sql).not.toMatch(/ON ALL TABLES|ALL PRIVILEGES|DEFAULT PRIVILEGES|GRANT SELECT ON /i);
    await run(sql);
    const later = deps("secval_monitor");
    later.now = () => new Date(Date.now() + 120_000);
    await runScan(db, "atlas", "deep", later);
    const d = getLatest(db, "atlas")!.result as unknown as AppResult;
    const c = d.checks.find((x) => x.checkId === "orph:projects.client_id")!;
    expect(c.failures).toBe(1);
    expect(d.permissions?.leastPrivilege).toBe(true);
    expect(d.permissions?.readableColumns).toBe(g.columns.length);
    const s = await pgConnector(as("secval_monitor"));
    try {
      await expect(isolated(s, "SELECT name FROM clients")).rejects.toThrow(/permission denied/); // a non-key column stays unreadable
      await expect(isolated(s, "SELECT amount FROM invoices")).rejects.toThrow(/permission denied/);
    } finally { await s.close(); }
  });

  it("blanket SELECT, a sensitive column, another schema or a write grant each make the login fail and the scan refuse", async () => {
    for (const [grant, failing] of [
      ["GRANT SELECT ON clients TO secval_monitor", "wide_select"],
      ["GRANT SELECT (secret_token) ON secrets_demo TO secval_monitor", "sensitive"],
      ["GRANT INSERT ON clients TO secval_monitor", "writable"],
      ["GRANT SELECT ON notes TO PUBLIC", "wide_select"], // a pre-existing PUBLIC grant also gives the login whole-table read
      ["GRANT USAGE ON SCHEMA other_demo TO secval_monitor", "schemas"],
    ] as const) {
      await reset();
      await run("CREATE TABLE IF NOT EXISTS secrets_demo (id int PRIMARY KEY, secret_token text); CREATE SCHEMA IF NOT EXISTS other_demo");
      await run(grant);
      const s = await pgConnector(as("secval_monitor"));
      try {
        const rep = await verifyPermissions(s);
        expect(rep.leastPrivilege, grant).toBe(false);
        expect(rep.checks.find((c) => c.id === failing)!.ok, grant).toBe(false);
      } finally { await s.close(); }
      const db = freshDb();
      expect(await runScan(db, "atlas", "quick", deps("secval_monitor"))).toMatchObject({ status: "error", message: "monitoring login has privileges it must not have; scan refused" });
    }
    await run("DROP TABLE IF EXISTS secrets_demo; DROP SCHEMA IF EXISTS other_demo");
  });

  it("the connectivity stages pass for the metadata-only login", async () => {
    await reset();
    const ok = await testConnectivity("atlas", { SECVAL_DBARCH_URL_ATLAS: as("secval_monitor") }, pgConnector);
    expect(ok.ok).toBe(true);
    expect(ok.stages.map((x) => x.id)).toEqual(["configured", "format", "tls_setting", "dns", "tcp", "login", "permissions"]);
  });
});

describe("dbarch: column-level grant generation", () => {
  const def = (t: string, c: string, pt: string, pc: string) => ({ child: { table: t, column: c }, parent: { table: pt, column: pc } }) as never;
  it("requests key columns only, never blanket or default privileges, and holds back sensitive-looking names", () => {
    const g = requiredGrants([def("projects", "client_id", "clients", "id"), def("mail", "email_id", "users", "id")], { table: "schema_migrations", column: "version" });
    expect(g.columns).toEqual(["clients.id", "mail.email_id".replace("mail.email_id", "projects.client_id"), "schema_migrations.version", "users.id"].sort());
    expect(g.skipped).toEqual(["mail.email_id"]);
    const sql = grantsSql(g, "2026-11-05");
    expect(sql).toContain('GRANT SELECT ("id") ON "clients" TO secval_monitor;');
    expect(sql).toContain("-- NOT granted");
    expect(sql).not.toMatch(/ALL TABLES|DEFAULT PRIVILEGES|GRANT SELECT ON /);
  });
});

describe("dbarch: TLS and connectivity stages (no network)", () => {
  it("refuses a remote connection string without sslmode", () => {
    expect(() => assertTlsRequired("postgresql://u:p@ep-x.neon.tech/db")).toThrow(ConnectError);
    expect(() => assertTlsRequired("postgresql://u:p@ep-x.neon.tech/db?sslmode=disable")).toThrow(ConnectError);
    expect(() => assertTlsRequired("postgresql://u:p@ep-x.neon.tech/db?sslmode=require")).not.toThrow();
    expect(() => assertTlsRequired("postgresql://u:p@localhost/db")).not.toThrow();
  });
  const net = (over: Partial<{ dns: boolean; tcp: boolean }> = {}) => ({
    resolve: async () => { if (over.dns === false) throw new Error("x"); },
    tcp: async () => { if (over.tcp === false) throw new Error("x"); },
  });
  const url = "postgresql://secval_monitor:SECRETPW@ep-x.neon.tech/db?sslmode=require";
  it("reports each stage, stops at the first failure and never echoes the password", async () => {
    const ok = await testConnectivity("nexus", { SECVAL_DBARCH_URL_NEXUS: url }, async () => new FakePg(sampleTables()), net());
    expect(ok.ok).toBe(true);
    expect(ok.permissions?.leastPrivilege).toBe(true);
    const noTcp = await testConnectivity("nexus", { SECVAL_DBARCH_URL_NEXUS: url }, async () => new FakePg(sampleTables()), net({ tcp: false }));
    expect(noTcp.ok).toBe(false);
    expect(noTcp.stages.at(-1)).toMatchObject({ id: "tcp", ok: false });
    const unset = await testConnectivity("nexus", {}, async () => new FakePg([]), net());
    expect(unset.stages).toEqual([{ id: "configured", label: "Secret is set on this server", ok: false, detail: "SECVAL_DBARCH_URL_NEXUS is not set" }]);
    const noTls = await testConnectivity("nexus", { SECVAL_DBARCH_URL_NEXUS: "postgresql://u:SECRETPW@ep-x.neon.tech/db" }, async () => new FakePg([]), net());
    expect(noTls.ok).toBe(false);
    expect(JSON.stringify([ok, noTcp, noTls])).not.toContain("SECRETPW");
  });
  it("an over-privileged login fails the permission stage and the scan fails closed (fixture)", async () => {
    const bad = async () => new FakePg(sampleTables(), { perms: { writable_tables: 2, memberships: "neon_superuser" } });
    const rep = await testConnectivity("atlas", { SECVAL_DBARCH_URL_ATLAS: url }, bad, net());
    expect(rep.ok).toBe(false);
    expect(rep.permissions?.checks.filter((c) => c.ok === false).map((c) => c.id)).toEqual(expect.arrayContaining(["writable", "roles"]));
    const db = freshDb();
    const out = await runScan(db, "atlas", "quick", { env: { SECVAL_DBARCH_URL_ATLAS: url }, now: () => T0, connect: bad });
    expect(out.status).toBe("error");
    expect(getLatest(db, "atlas")).toBeNull();
  });
  it("the connectivity endpoint requires auth and returns stages only", async () => {
    const db = freshDb();
    const app = createApp(db, { apiToken: "t", dbarch: { env: { SECVAL_DBARCH_URL_ATLAS: "postgresql://u:SECRETPW@localhost/db" }, now: () => T0, connect: async () => new FakePg(sampleTables()), net: { resolve: async () => undefined, tcp: async () => undefined } } });
    expect((await request(app).post("/api/dbarch/connectivity").send({})).status).toBe(401);
    const res = await request(app).post("/api/dbarch/connectivity").set({ Authorization: "Bearer t" }).send({ app: "atlas" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("SECRETPW");
    expect(res.body.reports[0].ok).toBe(true);
  });
  it("the kill switch stops database scans and connection tests", async () => {
    const db = freshDb();
    engage(db, "test");
    const r = rig();
    const out = await runScan(db, "atlas", "deep", r.deps);
    expect(out.status).toBe("skipped");
    expect(r.dbs.size).toBe(0);
    let connected = 0;
    const app = createApp(db, { apiToken: "t", dbarch: { env: { SECVAL_DBARCH_URL_ATLAS: "postgresql://u:p@localhost/db" }, now: () => T0, connect: async () => { connected++; return new FakePg(sampleTables()); }, net: { resolve: async () => undefined, tcp: async () => undefined } } });
    const res = await request(app).post("/api/dbarch/connectivity").set({ Authorization: "Bearer t" }).send({ app: "atlas" });
    expect(res.status).toBe(423);
    expect(connected).toBe(0);
  });
});
