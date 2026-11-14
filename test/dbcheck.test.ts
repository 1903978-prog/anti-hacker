import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import { engage } from "../server/governance/killswitch.js";
import { assessIntegrity, CAPPED_SCORE, checkDatabase, checkSelfDatabase, fkCoverage, latestDbCheck, requiredFkCoverage, scoreDbReport, selfDbReport, SELF_HOST, type DbReport, type JsonFetch } from "../server/health/dbcheck.js";
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
  requiredLinks: 30,
  requiredLinksValidated: 30,
  linkCandidatesOpen: 0,
  tablesClassified: 40,
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
    // Required links not reported -> 0 on that rule as well
    expect(scoreDbReport({ ...good, requiredLinks: null, requiredLinksValidated: null }, NOW).score).toBe(CAPPED_SCORE);
    expect(r.rules.find((x) => x.rule.startsWith("Restore"))!.note).toBe("not reported");
  });
  it("scores required FK enforcement; table-link share is diagnostic only (08 Nov 2026)", () => {
    const fk = (r: DbReport) => scoreDbReport(r, NOW).rules.find((x) => x.rule.startsWith("Required links"))!;
    // 48 of 60 required links enforced and validated -> 80% -> 8 points
    const part = { ...good, requiredLinks: 60, requiredLinksValidated: 48 };
    expect(fk(part).points).toBe(8);
    expect(fk(part).note).toContain("48 of 60 required foreign keys enforced and validated (80%)");
    expect(fk(part).note).toContain("diagnostic, not scored");
    // Rounding never gives full points while one required link is missing
    expect(fk({ ...good, requiredLinks: 100, requiredLinksValidated: 99 }).points).toBe(9);
    // Not reported: 0 points, however many tables take part in a foreign key
    const atlas = { ...good, tables: 407, foreignKeys: 3, tablesInLinks: 6, requiredLinks: undefined, requiredLinksValidated: undefined };
    expect(fk(atlas).points).toBe(0);
    expect(fk(atlas).note).toContain("required foreign keys not reported");
    expect(fk(atlas).note).toContain("6 of 407 tables linked");
    // Independent tables never lower the score: few linked tables, all required links valid -> full points
    const independentHeavy = { ...good, tables: 100, tablesInLinks: 10, foreignKeys: 5, requiredLinks: 5, requiredLinksValidated: 5, tablesClassified: 100 };
    expect(fk(independentHeavy).points).toBe(10);
    expect(requiredFkCoverage(independentHeavy)).toBe(1);
    // No required link: 100% only when no candidate is still open
    expect(requiredFkCoverage({ ...good, requiredLinks: 0, requiredLinksValidated: 0, linkCandidatesOpen: 0 })).toBe(1);
    expect(requiredFkCoverage({ ...good, requiredLinks: 0, requiredLinksValidated: 0, linkCandidatesOpen: 3 })).toBe(0);
    // The diagnostic share is still worked out the old way
    expect(fkCoverage({ ...good, tables: 1, foreignKeys: 0, tablesInLinks: undefined })).toBe(1);
  });
  it("a 9/10 score never hides missing required links, open candidates or orphan rows", () => {
    expect(scoreDbReport({ ...good, requiredLinks: 100, requiredLinksValidated: 99 }, NOW).score).toBe(CAPPED_SCORE);
    const open = scoreDbReport({ ...good, linkCandidatesOpen: 4 }, NOW);
    expect(open.score).toBe(CAPPED_SCORE);
    expect(open.rules[1]!.note).toContain("4 relationship candidates not investigated");
    expect(scoreDbReport({ ...good, linkCandidatesOpen: undefined }, NOW).score).toBe(CAPPED_SCORE);
    // Orphan rows cost their rule and also keep the score below 9/10; below the cap nothing changes
    expect(scoreDbReport({ ...good, orphanRows: 2 }, NOW).score).toBe(CAPPED_SCORE);
    expect(scoreDbReport({ ...good, orphanRows: 2, lastBackupAt: null }, NOW).score).toBe(80);
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
    expect(scoreDbReport(r, NOW).score).toBe(CAPPED_SCORE);
    const a = assessIntegrity(r, NOW);
    expect(a.verdict).toBe("critical");
    expect(a.findings[0]).toContain("2 orphan rows");
    expect(assessIntegrity({ ...good, lastRestoreTestAt: null }, NOW).verdict).toBe("critical");
    expect(assessIntegrity({ ...good, integrityOk: false }, NOW).verdict).toBe("critical");
  });
  it("missing required links, open candidates, unclassified tables or unreported facts are concerns", () => {
    const a = assessIntegrity({ ...good, requiredLinks: undefined, requiredLinksValidated: undefined, integrityOk: null }, NOW);
    expect(a.verdict).toBe("concerns");
    expect(a.findings.join(" ")).toContain("Required foreign keys not reported");
    expect(a.findings.join(" ")).toContain("Integrity check not reported");
    const b = assessIntegrity({ ...good, requiredLinks: 60, requiredLinksValidated: 48, linkCandidatesOpen: 5, tablesClassified: 35 }, NOW);
    expect(b.findings).toEqual(expect.arrayContaining([
      "12 of 60 required foreign keys not enforced and validated.",
      "5 relationship candidates not investigated yet.",
      "5 of 40 tables not classified.",
    ]));
  });
  it("independent or standalone tables are never a concern by themselves", () => {
    const a = assessIntegrity({ ...good, tables: 190, tablesInLinks: 20, standaloneTables: 150, tablesClassified: 190 }, NOW);
    expect(a).toEqual({ verdict: "sound", findings: [] });
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
    // Secval's register: 6 required links (migration 9 adds the two scorecard links);
    // 10 of 19 tables take part in a foreign key (diagnostic only; the two Lenovo monitor tables are D).
    expect(r).toMatchObject({ requiredLinks: 6, requiredLinksValidated: 6, linkCandidatesOpen: 0, tablesClassified: 19 });
    expect(r.tablesInLinks).toBe(10);
    // Backup and restore not reported in tests: 80.
    expect(scoreDbReport(r, NOW).score).toBe(80);
  });
  it("shows as measured on the dashboard", () => {
    const db = freshDb();
    checkSelfDatabase(db, () => NOW);
    const area = dashboard(db, NOW).find((a) => a.host === SELF_HOST)!.areas.find((a) => a.key === "database")!;
    expect(area.measured).toMatchObject({ score: 80, source: "measured" });
  });
});
