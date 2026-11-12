import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { DB } from "../db.js";

/**
 * Database relationship coverage (Livio, 08 Nov 2026). Standard, formulas
 * and evidence rules: docs/database-relationships.md.
 *
 * Every table gets exactly one category:
 *   A  FK-linked: in at least one valid, enforced foreign key, nothing missing
 *   B  FK-required, incomplete: at least one required link missing or invalid
 *   C  legitimately independent (reason required)
 *   D  external reference / special design (justification required)
 *   E  unresolved: not enough evidence yet
 *
 * The primary metric is Required FK Enforcement Coverage: valid, enforced and
 * validated required relationships over all confirmed required ones.
 * Independent tables are never in that denominator, so they cannot lower it.
 * A number only counts as verified when it comes from a reproducible
 * measurement and the independent review passed; everything else is shown as
 * provisional or UNVERIFIED, never as a fact.
 */

export type Category = "A" | "B" | "C" | "D" | "E";
export const CATEGORIES: Category[] = ["A", "B", "C", "D", "E"];

// --- Secval's own register ------------------------------------------------------
// Secval owns this database, so its register lives in code and is measured
// against the live SQLite catalogue every time it is read.

export interface RequiredLink {
  child: string;
  columns: string;
  parent: string;
  parentColumns: string;
  purpose: string;
  onDelete: string;
}

/** Relationships that must be enforced by a foreign key. */
export const SECVAL_REQUIRED_LINKS: RequiredLink[] = [
  { child: "findings", columns: "scan_id", parent: "scans", parentColumns: "id", purpose: "a finding belongs to one scan", onDelete: "NO ACTION (scans are never deleted)" },
  { child: "health_scores", columns: "report_id", parent: "health_reports", parentColumns: "id", purpose: "a score comes from one pasted report", onDelete: "NO ACTION" },
  { child: "health_infra", columns: "report_id", parent: "health_reports", parentColumns: "id", purpose: "an infrastructure fact comes from one pasted report", onDelete: "NO ACTION" },
  { child: "quality_snapshots", columns: "job_id", parent: "quality_runs", parentColumns: "job_id", purpose: "a trusted snapshot comes from one recorded run (same transaction, runs are append-only)", onDelete: "NO ACTION (runs cannot be deleted)" },
];

/** Relationships that are deliberately not foreign keys (category D links). */
export const SECVAL_EXCEPTIONS: Array<{ link: string; reason: string }> = [
  { link: "scans.target -> allowlist.domain", reason: "Scan history must outlive an allowlist removal; the policy engine checks the allowlist before every scan, and the audit trail is append-only, so an FK would block removals or rewrite history." },
  { link: "audit_log.target -> (any)", reason: "Append-only audit trail; target is free text (domain, URL or setting) and must never change or disappear." },
  { link: "uptime_checks / db_checks / health_reports / health_scores / health_infra .host -> app catalogue", reason: "The parent is the app catalogue in code (server/health/seed.ts), not a table; history must survive an app leaving the catalogue." },
  { link: "lenovo_samples / lenovo_alerts .app -> Lenovo monitor rows", reason: "The parent is the list of monitored apps in code (server/lenovo/monitor.ts MONITOR_ROWS), not a table; readings and alerts must survive an app leaving the list." },
  { link: "quality_runs.dataset -> dataset registry", reason: "The parent is the dataset registry in code (server/quality/datasets/), not a table; runs are append-only history." },
];

/** Category for each table when all its required links are valid. B is worked out live. */
export const SECVAL_TABLES: Record<string, { category: Category; reason: string }> = {
  scans: { category: "A", reason: "parent of findings" },
  findings: { category: "A", reason: "child of scans" },
  health_reports: { category: "A", reason: "parent of health_scores and health_infra" },
  health_scores: { category: "A", reason: "child of health_reports" },
  health_infra: { category: "A", reason: "child of health_reports" },
  quality_runs: { category: "A", reason: "parent of quality_snapshots" },
  quality_snapshots: { category: "A", reason: "child of quality_runs" },
  allowlist: { category: "D", reason: "root list; scans refer to it through the policy engine, not an FK (see exceptions)" },
  audit_log: { category: "C", reason: "append-only audit trail with free-text targets" },
  app_state: { category: "C", reason: "key-value settings (kill switch, last digest)" },
  uptime_checks: { category: "D", reason: "time series keyed by an app host from the code catalogue" },
  db_checks: { category: "D", reason: "time series keyed by an app host from the code catalogue" },
  schema_migrations: { category: "C", reason: "migration bookkeeping" },
  lenovo_samples: { category: "D", reason: "Lenovo monitor readings keyed by an app name from the code list" },
  lenovo_alerts: { category: "D", reason: "append-only Lenovo alert history keyed by an app name from the code list" },
};

export interface LinkResult extends RequiredLink {
  status: "enforced" | "missing" | "invalid";
  validated: boolean;
  orphans: number | null;
  indexed: boolean;
}

export interface SelfMeasure {
  tables: number;
  linkedTables: number;
  categories: Record<Category, number>;
  unclassifiedTables: string[];
  links: LinkResult[];
  required: number;
  valid: number;
  exceptions: number;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Measures Secval's register against the live SQLite catalogue. Read only. */
export function measureSelf(db: DB): SelfMeasure {
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((r) => r.name);
  const exists = new Set(names);
  const linked = new Set<string>();
  for (const t of names) {
    const fk = db.pragma(`foreign_key_list(${q(t)})`) as Array<{ table: string }>;
    if (fk.length) linked.add(t);
    for (const f of fk) if (exists.has(f.table)) linked.add(f.table);
  }
  const links: LinkResult[] = SECVAL_REQUIRED_LINKS.map((l) => {
    if (!exists.has(l.child) || !exists.has(l.parent)) return { ...l, status: "invalid", validated: false, orphans: null, indexed: false };
    const fk = (db.pragma(`foreign_key_list(${q(l.child)})`) as Array<{ table: string; from: string; to: string | null }>)
      .find((f) => f.table === l.parent && f.from === l.columns && (f.to ?? "id") === l.parentColumns);
    const orphans = (db.prepare(
      `SELECT COUNT(*) AS n FROM ${q(l.child)} c WHERE c.${q(l.columns)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(l.parent)} p WHERE p.${q(l.parentColumns)} = c.${q(l.columns)})`,
    ).get() as { n: number }).n;
    const idx = db.pragma(`index_list(${q(l.child)})`) as Array<{ name: string }>;
    const indexed = idx.some((i) => (db.pragma(`index_info(${q(i.name)})`) as Array<{ seqno: number; name: string }>).find((c) => c.seqno === 0)?.name === l.columns);
    if (!fk) return { ...l, status: "missing", validated: false, orphans, indexed };
    // SQLite enforces foreign keys on every write (foreign_keys = ON, set in db.ts);
    // the orphan count re-checks the rows already stored.
    return { ...l, status: orphans === 0 ? "enforced" : "invalid", validated: orphans === 0, orphans, indexed };
  });
  const incomplete = new Set<string>();
  for (const l of links) if (l.status !== "enforced") { incomplete.add(l.child); incomplete.add(l.parent); }
  const categories: Record<Category, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const unclassifiedTables: string[] = [];
  for (const t of names) {
    const entry = SECVAL_TABLES[t];
    if (!entry) { categories.E++; unclassifiedTables.push(t); continue; }
    categories[incomplete.has(t) ? "B" : entry.category]++;
  }
  return {
    tables: names.length,
    linkedTables: linked.size,
    categories,
    unclassifiedTables,
    links,
    required: links.length,
    valid: links.filter((l) => l.status === "enforced" && l.validated).length,
    exceptions: SECVAL_EXCEPTIONS.length,
  };
}

// --- The consolidated register (reports/db-relationships.json) --------------------

/** A number with where it came from. Only "measured" counts as evidence. */
const fact = z.object({
  value: z.number().int().min(0).nullable(),
  basis: z.enum(["measured", "reported", "unverified"]),
  evidence: z.string().max(600),
});
export type Fact = z.infer<typeof fact>;

const appSchema = z.object({
  key: z.string().max(40),
  app: z.string().max(60),
  owner: z.string().max(80),
  source: z.string().max(400),
  measuredAt: z.string().nullable(),
  schemas: z.array(z.object({ name: z.string().max(60), tables: z.number().int().min(0), note: z.string().max(300).optional() })).max(20),
  totalTables: fact,
  linkedTables: fact,
  /** Tables with a category A-D (E = unresolved does not count). */
  classifiedTotal: fact,
  /** Tables per category. */
  classified: z.object({ A: fact, B: fact, C: fact, D: fact, E: fact }),
  /** Valid, enforced and validated FKs (each counts as a confirmed required link). */
  validFks: fact,
  notValidatedFks: fact,
  confirmedMissing: fact,
  invalidFks: fact,
  candidatesIdentified: fact,
  candidatesOpen: fact,
  exceptions: fact,
  orphanIssues: z.array(z.object({ link: z.string().max(160), rows: z.number().int().min(0), basis: z.enum(["measured", "reported"]), status: z.string().max(200) })).max(100),
  ownerClaim: z.string().max(1200).optional(),
  review: z.enum(["passed", "pending", "failed"]),
  discoveryLimits: z.array(z.string().max(400)).max(20),
  prs: z.array(z.string().max(200)).max(20),
  nextSteps: z.array(z.string().max(400)).max(20),
});
export type AppRegister = z.infer<typeof appSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  collected_at: z.string(),
  how_measured: z.string().max(1200),
  apps: z.array(appSchema).max(20),
});

// --- Metrics A-E ---------------------------------------------------------------

export type Basis = "verified" | "provisional" | "unverified";
export interface Ratio {
  num: number | null;
  den: number | null;
  pct: number | null;
  basis: Basis;
  /** "48 / 60 = 80%", or why it cannot be worked out. */
  text: string;
}

function ratio(num: number | null, den: number | null, basis: Basis, why: string): Ratio {
  if (num === null || den === null) return { num, den, pct: null, basis: "unverified", text: `UNVERIFIED: ${why}` };
  if (den === 0) return { num, den, pct: 100, basis, text: `0 / 0 = 100% (not applicable)` };
  const pct = Math.floor((1000 * num) / den) / 10;
  return { num, den, pct, basis, text: `${num} / ${den} = ${pct}%` };
}

const isMeasured = (...fs: Fact[]) => fs.every((f) => f.basis === "measured" && f.value !== null);
const v = (f: Fact) => f.value;
/** verified = measured + reviewed; provisional = measured, review pending; unverified = any input only reported. */
const basisOf = (reviewed: boolean, extraOk: boolean, ...fs: Fact[]): Basis =>
  !isMeasured(...fs) ? "unverified" : reviewed && extraOk ? "verified" : "provisional";

export type Status = "Complete" | "Incomplete" | "Unverified";

export interface AppMetrics {
  key: string;
  app: string;
  owner: string;
  source: string;
  measuredAt: string | null;
  schemas: AppRegister["schemas"];
  totalTables: Fact;
  linkedTables: Fact;
  independentTables: Fact;
  unresolvedTables: number | null;
  requiredFks: number | null;
  validFks: Fact;
  missingOrInvalid: number | null;
  /** Metric A */ classification: Ratio;
  /** Metric B */ fkCoverage: Ratio;
  /** Metric C */ discovery: Ratio;
  /** Metric D */ independent: Ratio;
  /** Metric E */ backlog: { valid: Fact; missing: Fact; notValidatedOrInvalid: number | null; candidatesOpen: Fact; exceptions: Fact; orphanIssues: number };
  orphanIssues: AppRegister["orphanIssues"];
  status: Status;
  statusWhy: string[];
  line: string;
  review: AppRegister["review"];
  ownerClaim?: string;
  discoveryLimits: string[];
  prs: string[];
  nextSteps: string[];
  links?: LinkResult[];
}

/** Works out metrics A-E and the status for one app. Never invents a number. */
export function appMetrics(a: AppRegister): AppMetrics {
  const reviewed = a.review === "passed";
  const total = v(a.totalTables);
  const c = a.classified;
  const open = v(a.candidatesOpen);

  // Metric A
  const classification = ratio(v(a.classifiedTotal), total, basisOf(reviewed, true, a.classifiedTotal, a.totalTables),
    total === null ? "total tables not measured" : "classification not produced");

  // Metric B: denominator = every confirmed required link. Open candidates mean the
  // denominator may still grow, so the figure cannot be verified while any is open.
  const parts = [a.validFks, a.notValidatedFks, a.confirmedMissing, a.invalidFks];
  const den = parts.every((f) => v(f) !== null) ? parts.reduce((s, f) => s + (v(f) as number), 0) : null;
  const fkCoverage = den === null || open === null
    ? ratio(null, null, "unverified", `${v(a.validFks) ?? "?"} valid FKs measured; total required not established${open ? ` (${open} candidates open)` : ""}`)
    : ratio(v(a.validFks), den, basisOf(reviewed, open === 0, ...parts, a.candidatesOpen), "");
  if (open) fkCoverage.text += ` (${open} candidates still open)`;

  // Metric C
  const ident = v(a.candidatesIdentified);
  const discovery = ident === null || open === null
    ? ratio(null, null, "unverified", "candidate list not produced")
    : ratio(ident - open, ident, basisOf(reviewed, true, a.candidatesIdentified, a.candidatesOpen), "");

  // Metric D (descriptive, not a target)
  const independent = ratio(v(c.C), total, basisOf(reviewed, true, c.C, a.totalTables), "independent tables not established");

  const notValidatedOrInvalid = v(a.notValidatedFks) !== null && v(a.invalidFks) !== null ? (v(a.notValidatedFks) as number) + (v(a.invalidFks) as number) : null;
  const missingOrInvalid = notValidatedOrInvalid !== null && v(a.confirmedMissing) !== null ? notValidatedOrInvalid + (v(a.confirmedMissing) as number) : null;

  const why: string[] = [];
  if ((v(a.confirmedMissing) ?? 0) > 0) why.push(`${v(a.confirmedMissing)} confirmed required FKs missing`);
  if ((v(a.invalidFks) ?? 0) > 0) why.push(`${v(a.invalidFks)} FKs invalid`);
  if ((v(a.notValidatedFks) ?? 0) > 0) why.push(`${v(a.notValidatedFks)} FKs not validated`);
  const orphanRows = a.orphanIssues.reduce((s, o) => s + o.rows, 0);
  if (orphanRows > 0) why.push(`${orphanRows} orphan rows in ${a.orphanIssues.length} links`);
  let status: Status;
  if (why.length) status = "Incomplete";
  else if (classification.basis === "verified" && classification.pct === 100 && fkCoverage.basis === "verified" && fkCoverage.pct === 100) status = "Complete";
  else status = "Unverified";
  if (status !== "Complete") {
    if (classification.pct !== 100 || classification.basis !== "verified") why.push("classification incomplete or not reviewed");
    if (open === null) why.push("candidate list missing"); else if (open > 0) why.push(`${open} candidates open`);
    if (!reviewed) why.push("independent review not passed");
  }

  const n = (x: number | null) => (x === null ? "UNVERIFIED" : String(x));
  const line =
    `Required FKs: ${n(den)} | Validated: ${n(v(a.validFks))} | Missing/invalid: ${n(missingOrInvalid)} | ` +
    `Coverage: ${fkCoverage.text} | Independent tables: ${independent.basis === "verified" ? n(v(c.C)) : "UNVERIFIED"} | ` +
    `Classification: ${classification.text}` +
    (classification.basis !== "verified" || fkCoverage.basis !== "verified" ? " (not independently verified)" : "");

  return {
    key: a.key, app: a.app, owner: a.owner, source: a.source, measuredAt: a.measuredAt, schemas: a.schemas,
    totalTables: a.totalTables, linkedTables: a.linkedTables, independentTables: c.C,
    unresolvedTables: total !== null && v(a.classifiedTotal) !== null ? total - (v(a.classifiedTotal) as number) : null,
    requiredFks: den, validFks: a.validFks, missingOrInvalid,
    classification, fkCoverage, discovery, independent,
    backlog: { valid: a.validFks, missing: a.confirmedMissing, notValidatedOrInvalid, candidatesOpen: a.candidatesOpen, exceptions: a.exceptions, orphanIssues: a.orphanIssues.length },
    orphanIssues: a.orphanIssues, status, statusWhy: why, line, review: a.review, ownerClaim: a.ownerClaim,
    discoveryLimits: a.discoveryLimits, prs: a.prs, nextSteps: a.nextSteps,
  };
}

/** Secval's own row, measured live. The auditor reviews its own code, so review stays pending. */
export function selfRegister(db: DB, now: Date = new Date()): AppRegister {
  const m = measureSelf(db);
  const meas = (value: number, evidence: string): Fact => ({ value, basis: "measured", evidence });
  const missing = m.links.filter((l) => l.status === "missing").length;
  const invalid = m.links.filter((l) => l.status === "invalid").length;
  return {
    key: "secval",
    app: "Secval",
    owner: "Secval thread",
    source: "Live SQLite catalogue of this Secval instance, against the register in server/health/relationships.ts",
    measuredAt: now.toISOString(),
    schemas: [{ name: "main", tables: m.tables }],
    totalTables: meas(m.tables, "sqlite_master"),
    classifiedTotal: meas(m.tables - m.categories.E, "tables in SECVAL_TABLES"),
    linkedTables: meas(m.linkedTables, "PRAGMA foreign_key_list on every table"),
    classified: {
      A: meas(m.categories.A, "SECVAL_TABLES"), B: meas(m.categories.B, "required link missing or invalid"),
      C: meas(m.categories.C, "SECVAL_TABLES with reasons"), D: meas(m.categories.D, "SECVAL_TABLES with reasons"),
      E: meas(m.categories.E, m.unclassifiedTables.length ? `not in the register: ${m.unclassifiedTables.join(", ")}` : "none"),
    },
    validFks: meas(m.valid, "required links with a matching FK and 0 orphan rows"),
    notValidatedFks: meas(0, "SQLite checks every write; stored rows re-checked by the orphan count"),
    confirmedMissing: meas(missing, m.links.filter((l) => l.status === "missing").map((l) => `${l.child}.${l.columns} -> ${l.parent}.${l.parentColumns}`).join("; ") || "none"),
    invalidFks: meas(invalid, invalid ? "FK present but orphan rows found, or table missing" : "none"),
    candidatesIdentified: meas(m.required + m.exceptions, "every id/host/target column in the schema reviewed"),
    candidatesOpen: meas(0, "all candidates have a disposition"),
    exceptions: meas(m.exceptions, "SECVAL_EXCEPTIONS"),
    orphanIssues: m.links.filter((l) => (l.orphans ?? 0) > 0).map((l) => ({ link: `${l.child}.${l.columns} -> ${l.parent}.${l.parentColumns}`, rows: l.orphans!, basis: "measured" as const, status: "open" })),
    review: "pending",
    discoveryLimits: ["Secval classifies its own tables; an independent reviewer has not checked them yet."],
    prs: [],
    nextSteps: missing ? ["Release migration 7 (adds the quality_snapshots -> quality_runs FK); needs Livio's release approval."] : [],
  };
}

export interface RelationshipsReport {
  status: "ok" | "no-data" | "invalid";
  error?: string;
  collectedAt?: string;
  howMeasured?: string;
  apps: AppMetrics[];
}

/** The dashboard data: the reviewed register from the file, plus Secval measured live. */
export function loadRelationships(file: string, db: DB | null, now: Date = new Date()): RelationshipsReport {
  const self = db ? [{ ...appMetrics(selfRegister(db, now)), links: measureSelf(db).links }] : [];
  if (!existsSync(file)) return { status: "no-data", error: "No relationship register has been recorded yet.", apps: self };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { status: "invalid", error: "The relationship register is not valid JSON.", apps: self };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { status: "invalid", error: `The relationship register has the wrong shape at ${first?.path.join(".") || "top level"}: ${first?.message ?? "invalid"}.`, apps: self };
  }
  const apps = parsed.data.apps.filter((a) => a.key !== "secval").map(appMetrics);
  return { status: "ok", collectedAt: parsed.data.collected_at, howMeasured: parsed.data.how_measured, apps: [...apps, ...self] };
}
