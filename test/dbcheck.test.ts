import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import { engage } from "../server/governance/killswitch.js";
import { assessIntegrity, checkDatabase, checkSelfDatabase, fkCoverage, latestDbCheck, scoreDbReport, selfDbReport, SELF_HOST, type DbReport, type JsonFetch } from "../server/health/dbcheck.js";
import { dashboard } from "../server/health/score.js";

const HOST = "compplan.onrender.com";
const NOW = new Date("2026-11-06T12:00:00Z");

async function prove(db: ReturnType<typeof freshDb>, domain: string) {
  const { token } = createChallenge(db, domain, "op")!;
  await verifyOwnership(db, domain, "dns-txt", "op", { resolveTxt: async () => [[token]] });
}

const good: DbReport = {
  version: 1,
  engine: "postgresql",
  checkedAt: "2026-11-06T11:59:00Z",
  tables: 40,
  tablesWithoutPrimaryKey: 0,
  foreignKeys: 30,
  foreignKeysWithoutIndex: 0,
  tablesInLinks: 40,
  orphanRows: 0,
  uniqueConstraints: 12,
  checkConstraints: 5,
  pendingMigrations: 0,
  lastBackupAt: "2026-11-06T03:00:00Z",
  lastRestoreTestAt: "2026-11-01T03:00:00Z",
  integrityOk: true,
};

const answer = (body: unknown, status = 200): JsonFetch => async () => ({ status, text: JSON.stringify(body) });

describe("database structure rules", () => {
  it("a well-kept database scores 100", () => {
    expect(scoreDbReport(good, NOW).score).toBe(100);
  });
  it("each weakness costs its rule's points; unreported facts score 0", () => {
    const r = scoreDbReport(
      { ...good, tablesWithoutPrimaryKey: 4, foreignKeysWithoutIndex: 15, checkConstraints: 0, lastRestoreTestAt: null, pendingMigrations: null },
      NOW,
    );
    // PK 9, FK index 5, check 0, restore 0, migrations 0 -> 100 - 1 - 5 - 10 - 10 - 10
    expect(r.score).toBe(64);
    expect(r.rules.find((x) => x.rule.startsWith("Restore"))!.note).toBe("not reported");
  });
  it("a few foreign keys across many tables no longer earn full points (07 Nov 2026)", () => {
    const fk = (r: DbReport) => scoreDbReport(r, NOW).rules.find((x) => x.rule.startsWith("Links"))!;
    // ATLAS-like: 407 tables, 3 foreign keys, no tablesInLinks reported -> 3 of 406 links -> 0 points
    const atlas = { ...good, tables: 407, foreignKeys: 3, tablesInLinks: undefined };
    expect(fk(atlas).points).toBe(0);
    expect(fk(atlas).note).toContain("3 foreign keys for 407 tables");
    // Nexus-like: 160 tables, 126 foreign keys -> 79% -> 8 points
    expect(fk({ ...good, tables: 160, foreignKeys: 126, tablesInLinks: undefined }).points).toBe(8);
    // tablesInLinks wins when reported
    expect(fk({ ...good, tables: 193, foreignKeys: 52, tablesInLinks: 96 }).points).toBe(5);
    expect(fk({ ...good, tables: 193, foreignKeys: 52, tablesInLinks: 96 }).note).toContain("96 of 193 tables linked (50%)");
    // null (app could not count) falls back like a missing field
    expect(fk({ ...good, tables: 160, foreignKeys: 126, tablesInLinks: null }).points).toBe(8);
    // Declared standalone tables are excused, at most half of all tables
    expect(fk({ ...good, tables: 190, foreignKeys: 60, tablesInLinks: 63, standaloneTables: 100 }).points).toBe(7); // capped at 95 -> 63/95
    expect(fk({ ...good, tables: 190, foreignKeys: 60, tablesInLinks: 63, standaloneTables: 60 }).points).toBe(5); // 63/130
    expect(fk({ ...good, tables: 190, foreignKeys: 60, tablesInLinks: 63, standaloneTables: 60 }).note).toContain("60 standalone tables excused");
    // standalone without tablesInLinks is ignored
    expect(fk({ ...good, tables: 160, foreignKeys: 126, tablesInLinks: undefined, standaloneTables: 50 }).points).toBe(8);
    // One table: nothing to link
    expect(fkCoverage({ ...good, tables: 1, foreignKeys: 0, tablesInLinks: undefined })).toBe(1);
    // One foreign key in a 2-table database is full coverage
    expect(fk({ ...good, tables: 2, foreignKeys: 1, tablesInLinks: undefined }).points).toBe(10);
  });
  it("an old backup scores 0 on its rule", () => {
    expect(scoreDbReport({ ...good, lastBackupAt: "2026-11-04T00:00:00Z" }, NOW).score).toBe(90);
  });
});

describe("integrity assessment (separate from the score)", () => {
  it("a well-kept database is sound", () => {
    expect(assessIntegrity(good, NOW)).toEqual({ verdict: "sound", findings: [] });
  });
  it("broken data or no proven recovery is critical, even with a high score", () => {
    const r = { ...good, orphanRows: 2 };
    expect(scoreDbReport(r, NOW).score).toBe(90);
    const a = assessIntegrity(r, NOW);
    expect(a.verdict).toBe("critical");
    expect(a.findings[0]).toContain("2 orphan rows");
    expect(assessIntegrity({ ...good, lastRestoreTestAt: null }, NOW).verdict).toBe("critical");
    expect(assessIntegrity({ ...good, integrityOk: false }, NOW).verdict).toBe("critical");
  });
  it("low link coverage, missing keys or unreported facts are concerns", () => {
    const a = assessIntegrity({ ...good, tables: 407, foreignKeys: 3, tablesInLinks: undefined, integrityOk: null }, NOW);
    expect(a.verdict).toBe("concerns");
    expect(a.findings.join(" ")).toContain("Only 1% foreign-key coverage");
    expect(a.findings.join(" ")).toContain("Integrity check not reported");
  });
  it("a large or over-cap standalone declaration is a concern to review", () => {
    const a = assessIntegrity({ ...good, tables: 190, tablesInLinks: 63, standaloneTables: 100 }, NOW);
    expect(a.verdict).toBe("concerns");
    expect(a.findings.join(" ")).toContain("95 of 190 tables declared standalone");
    expect(a.findings.join(" ")).toContain("100 tables declared standalone, only 95 excused");
  });
  it("is stored with the check and shown on the dashboard", async () => {
    const db = freshDb();
    await prove(db, HOST);
    await checkDatabase(db, HOST, "tok", answer({ ...good, orphanRows: 1 }), () => NOW);
    expect(latestDbCheck(db, HOST)!.integrity!.verdict).toBe("critical");
    const area = dashboard(db, NOW).find((a) => a.host === HOST)!.areas.find((a) => a.key === "database")!;
    expect(area.measured!.evidence.join(" ")).toContain("Integrity assessment (separate from the score): CRITICAL");
  });
});

describe("database structure check", () => {
  it("never contacts an unproven app, or one without a token", async () => {
    const db = freshDb();
    let called = false;
    const spy: JsonFetch = async (...a) => ((called = true), answer(good)(...a));
    expect(await checkDatabase(db, HOST, "tok", spy, () => NOW)).toBeNull();
    await prove(db, HOST);
    expect(await checkDatabase(db, HOST, undefined, spy, () => NOW)).toBeNull();
    expect(called).toBe(false);
  });

  it("does nothing while the kill switch is engaged", async () => {
    const db = freshDb();
    await prove(db, HOST);
    engage(db, "op");
    expect(await checkDatabase(db, HOST, "tok", answer(good), () => NOW)).toBeNull();
  });

  it("sends the token and makes the Database column measured", async () => {
    const db = freshDb();
    await prove(db, HOST);
    let auth = "";
    const f: JsonFetch = async (url, init) => ((auth = init.headers.authorization!), { status: 200, text: JSON.stringify({ ...good, checkConstraints: 0 }) });
    const c = (await checkDatabase(db, HOST, "tok", f, () => NOW))!;
    expect(auth).toBe("Bearer tok");
    expect(c).toMatchObject({ ok: true, score: 90 });
    const area = dashboard(db, NOW).find((a) => a.host === HOST)!.areas.find((a) => a.key === "database")!;
    expect(area.measured).toMatchObject({ score: 90, source: "measured" });
    expect(area.measured!.evidence.join(" ")).toContain("0/10 Bad values blocked");
  });

  it("an app without a report (404) is skipped, a bad answer is logged as failed and gives no score", async () => {
    const db = freshDb();
    await prove(db, HOST);
    expect(await checkDatabase(db, HOST, "tok", answer({}, 404), () => NOW)).toBeNull();
    const bad = (await checkDatabase(db, HOST, "tok", answer({ version: 1, tables: "lots" }), () => NOW))!;
    expect(bad.ok).toBe(false);
    expect(latestDbCheck(db, HOST)!.ok).toBe(false);
    const area = dashboard(db, NOW).find((a) => a.host === HOST)!.areas.find((a) => a.key === "database")!;
    expect(area.measured).toBeNull();
  });

  it("a check older than 3 days no longer counts", async () => {
    const db = freshDb();
    await prove(db, HOST);
    const old = { ...good, checkedAt: "2026-10-31T23:00:00Z", lastBackupAt: "2026-10-31T03:00:00Z", lastRestoreTestAt: "2026-10-30T00:00:00Z" };
    expect((await checkDatabase(db, HOST, "tok", answer(old), () => new Date("2026-11-01T00:00:00Z")))!.ok).toBe(true);
    const area = dashboard(db, NOW).find((a) => a.host === HOST)!.areas.find((a) => a.key === "database")!;
    expect(area.measured).toBeNull();
  });

  it("accepts a cached report up to 3 days old, refuses an older one", async () => {
    const db = freshDb();
    await prove(db, HOST);
    const day = (await checkDatabase(db, HOST, "tok", answer({ ...good, checkedAt: "2026-11-05T12:00:00Z" }), () => NOW))!;
    expect(day.ok).toBe(true);
    const stale = (await checkDatabase(db, HOST, "tok", answer({ ...good, checkedAt: "2026-11-02T12:00:00Z" }), () => NOW))!;
    expect(stale).toMatchObject({ ok: false, score: null });
    expect(stale.error).toContain("stale");
  });
});

describe("secval's own database", () => {
  it("is read from SQLite's catalogue: keys, links, indexes, rules, migrations, integrity", () => {
    const db = freshDb();
    const r = selfDbReport(db, NOW);
    expect(r).toMatchObject({ engine: "sqlite", tablesWithoutPrimaryKey: 0, foreignKeysWithoutIndex: 0, orphanRows: 0, pendingMigrations: 0, integrityOk: true });
    expect(r.foreignKeys).toBeGreaterThan(0);
    expect(r.checkConstraints).toBeGreaterThan(0);
    // No backup running in tests: backup and restore are not reported, never guessed.
    expect(r.lastBackupAt).toBeNull();
    // 5 of 13 tables take part in a foreign key since the 07 Nov 2026 coverage rule: 4/10 on links.
    expect(r.tablesInLinks).toBe(5);
    expect(scoreDbReport(r, NOW).score).toBe(74);
  });
  it("shows as measured on the dashboard", () => {
    const db = freshDb();
    checkSelfDatabase(db, () => NOW);
    const area = dashboard(db, NOW).find((a) => a.host === SELF_HOST)!.areas.find((a) => a.key === "database")!;
    expect(area.measured).toMatchObject({ score: 74, source: "measured" });
  });
});
