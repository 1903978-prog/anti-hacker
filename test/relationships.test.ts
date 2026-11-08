import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "./helpers.js";
import { appMetrics, loadRelationships, measureSelf, selfRegister, type AppRegister, type Fact } from "../server/health/relationships.js";

const m = (value: number | null): Fact => ({ value, basis: "measured", evidence: "test" });
const r = (value: number | null): Fact => ({ value, basis: "reported", evidence: "test" });

/** A fully measured, reviewed app: 48 of 60 required links valid. */
const base: AppRegister = {
  key: "demo", app: "Demo", owner: "demo thread", source: "test", measuredAt: "2026-11-08T05:00:00Z",
  schemas: [{ name: "public", tables: 100 }],
  totalTables: m(100), linkedTables: m(50), classifiedTotal: m(100),
  classified: { A: m(40), B: m(10), C: m(45), D: m(5), E: m(0) },
  validFks: m(48), notValidatedFks: m(0), confirmedMissing: m(12), invalidFks: m(0),
  candidatesIdentified: m(80), candidatesOpen: m(0), exceptions: m(20),
  orphanIssues: [], review: "passed", discoveryLimits: [], prs: [], nextSteps: [],
};

describe("relationship metrics A-E", () => {
  it("shows every percentage with its numerator and denominator", () => {
    const x = appMetrics(base);
    expect(x.fkCoverage).toMatchObject({ num: 48, den: 60, pct: 80, basis: "verified", text: "48 / 60 = 80%" });
    expect(x.classification.text).toBe("100 / 100 = 100%");
    expect(x.discovery.text).toBe("80 / 80 = 100%");
    expect(x.independent.text).toBe("45 / 100 = 45%");
    expect(x.line).toBe("Required FKs: 60 | Validated: 48 | Missing/invalid: 12 | Coverage: 48 / 60 = 80% | Independent tables: 45 | Classification: 100 / 100 = 100%");
  });
  it("a confirmed missing link makes the app Incomplete", () => {
    expect(appMetrics(base)).toMatchObject({ status: "Incomplete", statusWhy: expect.arrayContaining(["12 confirmed required FKs missing"]) });
  });
  it("Complete needs 100% of everything, measured and reviewed", () => {
    const done = { ...base, validFks: m(60), confirmedMissing: m(0) };
    expect(appMetrics(done).status).toBe("Complete");
    expect(appMetrics({ ...done, review: "pending" }).status).toBe("Unverified");
    expect(appMetrics({ ...done, candidatesOpen: m(3) }).status).toBe("Unverified");
    expect(appMetrics({ ...done, classifiedTotal: m(99) }).status).toBe("Unverified");
    expect(appMetrics({ ...done, orphanIssues: [{ link: "a.b -> c.d", rows: 2, basis: "measured", status: "open" }] }).status).toBe("Incomplete");
  });
  it("independent tables never change FK coverage", () => {
    const more = { ...base, classified: { ...base.classified, C: m(90), A: m(0), D: m(0) } };
    expect(appMetrics(more).fkCoverage.text).toBe(appMetrics(base).fkCoverage.text);
  });
  it("an app's own figures are UNVERIFIED, measured but unreviewed ones provisional", () => {
    const owner = appMetrics({ ...base, confirmedMissing: r(12), classifiedTotal: r(100) });
    expect(owner.fkCoverage.basis).toBe("unverified");
    expect(owner.classification.basis).toBe("unverified");
    expect(owner.line).toContain("Independent tables: 45");
    expect(owner.line).toContain("(not independently verified)");
    const pending = appMetrics({ ...base, review: "pending" });
    expect(pending.fkCoverage.basis).toBe("provisional");
    expect(pending.line).toContain("Independent tables: UNVERIFIED");
  });
  it("never invents a number: unknown inputs give UNVERIFIED", () => {
    const x = appMetrics({ ...base, confirmedMissing: r(null), candidatesOpen: r(null), candidatesIdentified: r(null), classifiedTotal: r(null) });
    expect(x.requiredFks).toBeNull();
    expect(x.fkCoverage.pct).toBeNull();
    expect(x.fkCoverage.text).toContain("UNVERIFIED");
    expect(x.classification.text).toContain("UNVERIFIED");
    expect(x.line).toContain("Required FKs: UNVERIFIED");
    expect(x.status).toBe("Unverified");
  });
  it("open candidates are shown next to the coverage and keep it from being verified", () => {
    const x = appMetrics({ ...base, candidatesOpen: m(5) });
    expect(x.fkCoverage.basis).toBe("provisional");
    expect(x.fkCoverage.text).toBe("48 / 60 = 80% (5 candidates still open)");
    expect(x.discovery.text).toBe("75 / 80 = 93.7%");
  });
  it("no required FK shows 100% / not applicable", () => {
    const x = appMetrics({ ...base, validFks: m(0), confirmedMissing: m(0) });
    expect(x.fkCoverage.text).toBe("0 / 0 = 100% (not applicable)");
  });
});

describe("Secval's own register", () => {
  it("classifies every table and finds all four required links enforced", () => {
    const s = measureSelf(freshDb());
    expect(s.tables).toBe(13);
    expect(s.unclassifiedTables).toEqual([]);
    expect(s.categories).toEqual({ A: 7, B: 0, C: 3, D: 3, E: 0 });
    expect(s.required).toBe(4);
    expect(s.valid).toBe(4);
    expect(s.links.every((l) => l.indexed || l.child === "findings" || l.child.startsWith("health_"))).toBe(true);
  });
  it("a missing foreign key turns both tables into B and the app Incomplete", () => {
    const db = freshDb();
    db.exec(`PRAGMA foreign_keys = OFF;
      CREATE TABLE qs_old (dataset TEXT PRIMARY KEY, job_id TEXT NOT NULL, taken_at TEXT NOT NULL, record_count INTEGER NOT NULL, fingerprints TEXT NOT NULL);
      DROP TABLE quality_snapshots; ALTER TABLE qs_old RENAME TO quality_snapshots;
      INSERT INTO quality_snapshots VALUES ('d', 'no-such-job', 'now', 0, '[]');
      PRAGMA foreign_keys = ON;`);
    const s = measureSelf(db);
    expect(s.valid).toBe(3);
    expect(s.categories.B).toBe(2);
    const link = s.links.find((l) => l.child === "quality_snapshots")!;
    expect(link).toMatchObject({ status: "missing", orphans: 1 });
    const x = appMetrics(selfRegister(db));
    expect(x.status).toBe("Incomplete");
    expect(x.fkCoverage.text).toBe("3 / 4 = 75%");
    expect(x.orphanIssues[0]).toMatchObject({ rows: 1 });
  });
  it("a new table nobody classified counts as E", () => {
    const db = freshDb();
    db.exec(`CREATE TABLE mystery (id INTEGER PRIMARY KEY)`);
    const s = measureSelf(db);
    expect(s.unclassifiedTables).toEqual(["mystery"]);
    expect(appMetrics(selfRegister(db)).classification.text).toBe("13 / 14 = 92.8%");
  });
  it("stays unverified until someone else reviews it", () => {
    const x = appMetrics(selfRegister(freshDb()));
    expect(x.status).toBe("Unverified");
    expect(x.fkCoverage).toMatchObject({ text: "4 / 4 = 100%", basis: "provisional" });
  });
});

describe("the register file", () => {
  it("the committed register is valid and lists all five apps, Secval measured live", () => {
    const rep = loadRelationships(join(process.cwd(), "reports", "db-relationships.json"), freshDb());
    expect(rep.status).toBe("ok");
    expect(rep.apps.map((a) => a.key)).toEqual(["compplan", "lm-op-model", "nexus", "10bonds", "secval"]);
    // Nothing in it is verified yet: every app's own figures still need review.
    for (const a of rep.apps) expect(a.status).not.toBe("Complete");
  });
  it("a broken file is reported, never shown as data", () => {
    const dir = mkdtempSync(join(tmpdir(), "rel-"));
    const bad = join(dir, "r.json");
    writeFileSync(bad, JSON.stringify({ version: 1, collected_at: "x", how_measured: "", apps: [{ key: "x" }] }));
    const rep = loadRelationships(bad, null);
    expect(rep.status).toBe("invalid");
    expect(rep.apps).toEqual([]);
    expect(loadRelationships(join(dir, "missing.json"), null).status).toBe("no-data");
  });
});
