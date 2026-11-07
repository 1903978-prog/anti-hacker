import { z } from "zod";
import type { DB } from "../db.js";
import { listAllowlist } from "../ownership/allowlist.js";
import { requestApproval } from "../governance/policy.js";
import { checkIntegrity } from "../integrity.js";
import { backupMode, getLastDrill } from "../backup/drill.js";

/**
 * Database structure check. Once an hour secval asks each proven app for a
 * short report about its own database (counts and yes/no answers only, never
 * any row data) and scores it with ten fixed rules. Contract and reference
 * SQL: docs/database-check.md.
 */
export const DBCHECK_PATH = "/api/secval/db-health";
export const DBCHECK_EVERY_MS = 60 * 60_000;
const TIMEOUT_MS = 15_000;
/** Bigger answers are refused: the report is a handful of numbers. */
const MAX_BYTES = 16_384;
/** A cached report is fine (some apps compute it once a day); older than this is not. */
const REPORT_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

const count = z.number().int().min(0);
const when = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date-time").nullable();

export const dbReportSchema = z.object({
  version: z.literal(1),
  engine: z.string().max(40),
  checkedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  tables: count,
  tablesWithoutPrimaryKey: count,
  foreignKeys: count,
  foreignKeysWithoutIndex: count,
  /** Optional: tables taking part in at least one foreign key (as child or parent). */
  tablesInLinks: count.nullish(),
  orphanRows: count.nullable(),
  uniqueConstraints: count,
  checkConstraints: count,
  pendingMigrations: count.nullable(),
  lastBackupAt: when,
  lastRestoreTestAt: when,
  integrityOk: z.boolean().nullable(),
});
export type DbReport = z.infer<typeof dbReportSchema>;

export interface RuleResult {
  rule: string;
  points: number;
  note: string;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * How much of the database is held together by enforced links, 0 to 1.
 * With `tablesInLinks`: the share of tables in at least one foreign key.
 * Without it: foreign keys against the tables - 1 links a connected schema
 * needs at minimum. A few foreign keys across many tables is not coverage
 * (07 Nov 2026: one foreign key used to earn full points).
 */
export function fkCoverage(r: DbReport): number {
  if (r.tables <= 1) return 1;
  if (r.tablesInLinks != null) return Math.min(1, r.tablesInLinks / r.tables);
  return Math.min(1, r.foreignKeys / (r.tables - 1));
}

function fkNote(r: DbReport): string {
  const pct = Math.round(100 * fkCoverage(r));
  if (r.tables <= 1) return `${r.foreignKeys} foreign keys, only one table`;
  return r.tablesInLinks != null
    ? `${r.foreignKeys} foreign keys; ${r.tablesInLinks} of ${r.tables} tables linked (${pct}%)`
    : `${r.foreignKeys} foreign keys for ${r.tables} tables (${pct}% of the ${r.tables - 1} links a connected schema needs)`;
}

export type IntegrityVerdict = "sound" | "concerns" | "critical";
export interface IntegrityAssessment {
  verdict: IntegrityVerdict;
  findings: string[];
}

/**
 * A separate integrity assessment, shown next to the score and never folded
 * into it: a database can reach a high score and still have a defect that
 * blocks "done". Critical = broken data or no proven recovery.
 */
export function assessIntegrity(r: DbReport, now: Date = new Date()): IntegrityAssessment {
  const critical: string[] = [];
  const concerns: string[] = [];
  const age = (iso: string | null) => (iso ? now.getTime() - Date.parse(iso) : null);
  if (r.integrityOk === false) critical.push("Integrity check failed.");
  if (r.integrityOk === null) concerns.push("Integrity check not reported.");
  if (r.orphanRows !== null && r.orphanRows > 0) critical.push(`${r.orphanRows} orphan rows (links pointing at nothing).`);
  if (r.orphanRows === null) concerns.push("Orphan rows not reported.");
  const backupAge = age(r.lastBackupAt);
  if (backupAge === null || backupAge > 26 * HOUR) critical.push(r.lastBackupAt ? `Last backup ${r.lastBackupAt}, older than 26 hours.` : "No backup reported.");
  const restoreAge = age(r.lastRestoreTestAt);
  if (restoreAge === null || restoreAge > 35 * DAY) critical.push(r.lastRestoreTestAt ? `Last restore test ${r.lastRestoreTestAt}, older than 35 days.` : "No restore test reported.");
  const cov = fkCoverage(r);
  if (cov < 0.5) concerns.push(`Only ${Math.round(100 * cov)}% foreign-key coverage (${r.foreignKeys} foreign keys, ${r.tables} tables).`);
  if (r.tablesWithoutPrimaryKey > 0) concerns.push(`${r.tablesWithoutPrimaryKey} tables without a primary key.`);
  if (r.checkConstraints === 0 && r.tables > 1) concerns.push("No CHECK rules.");
  if (r.pendingMigrations !== null && r.pendingMigrations > 0) concerns.push(`${r.pendingMigrations} pending migrations.`);
  return { verdict: critical.length ? "critical" : concerns.length ? "concerns" : "sound", findings: [...critical, ...concerns] };
}

/** Ten rules, 10 points each. Anything the app does not report scores 0 and says so. */
export function scoreDbReport(r: DbReport, now: Date = new Date()): { score: number; rules: RuleResult[] } {
  const share = (bad: number, total: number) => (total === 0 ? 0 : Math.max(0, 1 - bad / total));
  const age = (iso: string | null) => (iso ? now.getTime() - Date.parse(iso) : null);
  const backupAge = age(r.lastBackupAt);
  const restoreAge = age(r.lastRestoreTestAt);
  const rules: RuleResult[] = [
    {
      rule: "Every table has a primary key",
      points: r.tables ? Math.round(10 * share(r.tablesWithoutPrimaryKey, r.tables)) : 0,
      note: `${r.tablesWithoutPrimaryKey} of ${r.tables} tables without one`,
    },
    {
      rule: "Links between tables are enforced (foreign keys)",
      points: Math.round(10 * fkCoverage(r)),
      note: fkNote(r),
    },
    {
      rule: "Linked columns are indexed",
      points: r.foreignKeys ? Math.round(10 * share(r.foreignKeysWithoutIndex, r.foreignKeys)) : r.tables <= 1 ? 10 : 0,
      note: `${r.foreignKeysWithoutIndex} of ${r.foreignKeys} foreign keys without an index`,
    },
    {
      rule: "No broken links (orphan rows)",
      points: r.orphanRows === 0 ? 10 : 0,
      note: r.orphanRows === null ? "not reported" : `${r.orphanRows} orphan rows`,
    },
    {
      rule: "Duplicates blocked (unique rules)",
      points: r.uniqueConstraints > 0 ? 10 : 0,
      note: `${r.uniqueConstraints} unique rules`,
    },
    {
      rule: "Bad values blocked (check rules)",
      points: r.checkConstraints > 0 ? 10 : 0,
      note: `${r.checkConstraints} check rules`,
    },
    {
      rule: "Database matches the code (no pending migrations)",
      points: r.pendingMigrations === 0 ? 10 : 0,
      note: r.pendingMigrations === null ? "not reported" : `${r.pendingMigrations} pending`,
    },
    {
      rule: "Backup in the last 26 hours",
      points: backupAge !== null && backupAge >= -HOUR && backupAge <= 26 * HOUR ? 10 : 0,
      note: r.lastBackupAt ? `last backup ${r.lastBackupAt}` : "not reported",
    },
    {
      rule: "Restore tested in the last 35 days",
      points: restoreAge !== null && restoreAge >= -HOUR && restoreAge <= 35 * DAY ? 10 : 0,
      note: r.lastRestoreTestAt ? `last restore test ${r.lastRestoreTestAt}` : "not reported",
    },
    {
      rule: "Database integrity check passes",
      points: r.integrityOk === true ? 10 : 0,
      note: r.integrityOk === null ? "not reported" : r.integrityOk ? "passed" : "FAILED",
    },
  ];
  return { score: rules.reduce((a, x) => a + x.points, 0), rules };
}

export interface DbCheck {
  host: string;
  ts: string;
  ok: boolean;
  score: number | null;
  rules: RuleResult[];
  error: string | null;
  integrity?: IntegrityAssessment | null;
}

export type JsonFetch = (url: string, init: { headers: Record<string, string>; timeoutMs: number }) => Promise<{ status: number; text: string }>;

const realFetch: JsonFetch = async (url, init) => {
  const res = await fetch(url, { redirect: "manual", headers: init.headers, signal: AbortSignal.timeout(init.timeoutMs) });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, MAX_BYTES + 1) };
};

/**
 * Asks one app for its database report. Passes the policy gate first
 * (passive), so an unproven host or an engaged kill switch means nothing is
 * sent. Without a token configured, nothing is sent either. Only the score
 * and the rule notes are kept.
 */
export async function checkDatabase(
  db: DB,
  target: string,
  token: string | undefined = process.env.SECVAL_DBCHECK_TOKEN,
  fetcher: JsonFetch = realFetch,
  now: () => Date = () => new Date(),
): Promise<DbCheck | null> {
  if (!token) return null;
  const decision = requestApproval(db, { actor: "dbcheck", target, mode: "passive" });
  if (!decision.allowed || !decision.host) return null;
  const host = decision.host;

  let check: DbCheck;
  try {
    const res = await fetcher(`https://${host}${DBCHECK_PATH}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "secval-dbcheck/0.1 (+authorized self-check)" },
      timeoutMs: TIMEOUT_MS,
    });
    // 404 = the app has no database report yet: not a failure, just nothing to score.
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (res.text.length > MAX_BYTES) throw new Error("report too big");
    const parsed = dbReportSchema.safeParse(JSON.parse(res.text));
    if (!parsed.success) throw new Error(`bad report: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")).join(", ")}`);
    // Apps that may wake their database only a few times a day serve a cached
    // report; up to 3 days old is accepted, older is not trusted.
    const age = now().getTime() - Date.parse(parsed.data.checkedAt);
    if (age > REPORT_MAX_AGE_MS) throw new Error(`report is stale (checked ${parsed.data.checkedAt})`);
    if (age < -HOUR) throw new Error("report is dated in the future");
    const { score, rules } = scoreDbReport(parsed.data, now());
    check = { host, ts: parsed.data.checkedAt, ok: true, score, rules, error: null, integrity: assessIntegrity(parsed.data, now()) };
  } catch (err) {
    check = { host, ts: now().toISOString(), ok: false, score: null, rules: [], error: (err as Error).message.slice(0, 200), integrity: null };
  }
  saveCheck(db, check);
  return check;
}

export async function checkAllDatabases(db: DB, token?: string, fetcher?: JsonFetch): Promise<DbCheck[]> {
  const out: DbCheck[] = [checkSelfDatabase(db)];
  for (const e of listAllowlist(db).filter((e) => e.ownershipProven && e.domain !== SELF_HOST)) {
    const c = await checkDatabase(db, e.domain, token ?? process.env.SECVAL_DBCHECK_TOKEN, fetcher);
    if (c) out.push(c);
  }
  return out;
}

function saveCheck(db: DB, c: DbCheck): void {
  db.prepare(`INSERT INTO db_checks (host, ts, ok, score, rules_json, error, integrity_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    c.host, c.ts, c.ok ? 1 : 0, c.score, JSON.stringify(c.rules), c.error, c.integrity ? JSON.stringify(c.integrity) : null,
  );
}

/** The newest database check of a host, if any. */
export function latestDbCheck(db: DB, host: string): DbCheck | null {
  const r = db.prepare(`SELECT * FROM db_checks WHERE host = ? ORDER BY id DESC LIMIT 1`).get(host) as
    | { host: string; ts: string; ok: number; score: number | null; rules_json: string; error: string | null; integrity_json: string | null }
    | undefined;
  if (!r) return null;
  return {
    host: r.host, ts: r.ts, ok: r.ok === 1, score: r.score, rules: JSON.parse(r.rules_json) as RuleResult[], error: r.error,
    integrity: r.integrity_json ? (JSON.parse(r.integrity_json) as IntegrityAssessment) : null,
  };
}

export function startDbChecker(db: DB): () => void {
  const run = () => void checkAllDatabases(db).catch(() => {
    /* a failed round must not crash the server */
  });
  const first = setTimeout(run, 90_000);
  const timer = setInterval(run, DBCHECK_EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** Secval's own address on the dashboard. */
export const SELF_HOST = "secval.onrender.com";

/**
 * Secval's own database, read directly from SQLite's catalogue (no network).
 * Backup and restore dates come from the daily restore drill: a passing drill
 * restored the live backup into a scratch file and checked it.
 */
export function selfDbReport(db: DB, now: Date = new Date()): DbReport {
  const tables = (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string; sql: string | null }>);
  let noPk = 0;
  let fks = 0;
  let fksNoIndex = 0;
  const linked = new Set<string>();
  let unique = 0;
  let checks = 0;
  for (const t of tables) {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const cols = db.pragma(`table_info(${q(t.name)})`) as Array<{ pk: number }>;
    if (!cols.some((c) => c.pk > 0)) noPk++;
    const idx = db.pragma(`index_list(${q(t.name)})`) as Array<{ name: string; unique: number; origin: string }>;
    unique += idx.filter((i) => i.unique === 1 && i.origin !== "pk").length;
    const leading = new Set(
      idx.map((i) => (db.pragma(`index_info(${q(i.name)})`) as Array<{ seqno: number; name: string }>).find((c) => c.seqno === 0)?.name),
    );
    const fk = db.pragma(`foreign_key_list(${q(t.name)})`) as Array<{ id: number; seq: number; from: string; table: string }>;
    const first = fk.filter((f) => f.seq === 0);
    if (first.length) linked.add(t.name);
    for (const f of first) linked.add(f.table);
    fks += first.length;
    fksNoIndex += first.filter((f) => !leading.has(f.from)).length;
    checks += ((t.sql ?? "").match(/\bCHECK\s*\(/gi) ?? []).length;
  }
  const integrity = checkIntegrity(db, now);
  const drill = getLastDrill(db);
  const drillOk = backupMode() === "on" && !!drill?.ok;
  return {
    version: 1,
    engine: "sqlite",
    checkedAt: now.toISOString(),
    tables: tables.length,
    tablesWithoutPrimaryKey: noPk,
    foreignKeys: fks,
    foreignKeysWithoutIndex: fksNoIndex,
    tablesInLinks: [...linked].filter((n) => tables.some((t) => t.name === n)).length,
    orphanRows: integrity.brokenLinks >= 0 ? integrity.brokenLinks : null,
    uniqueConstraints: unique,
    checkConstraints: checks,
    pendingMigrations: Math.max(0, integrity.expectedSchemaVersion - integrity.schemaVersion),
    lastBackupAt: drillOk ? drill!.at : null,
    lastRestoreTestAt: drillOk ? drill!.at : null,
    integrityOk: integrity.ok,
  };
}

/** Scores Secval's own database and logs it like any other check. */
export function checkSelfDatabase(db: DB, now: () => Date = () => new Date()): DbCheck {
  const report = selfDbReport(db, now());
  const { score, rules } = scoreDbReport(report, now());
  const check: DbCheck = { host: SELF_HOST, ts: now().toISOString(), ok: true, score, rules, error: null, integrity: assessIntegrity(report, now()) };
  saveCheck(db, check);
  return check;
}
