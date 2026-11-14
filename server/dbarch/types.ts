/**
 * Database Architecture & Integrity module: shared shapes.
 * Everything here describes MEASUREMENTS of a monitored database. Nothing in
 * this module ever writes to a monitored database.
 */

export type AppKey = "atlas" | "lm-op-model" | "nexus";
export const APP_KEYS: AppKey[] = ["atlas", "lm-op-model", "nexus"];

/** VERIFIED = every input measured fresh; PARTIAL = some inputs missing; UNVERIFIED = most/all missing (score N/V); STALE = older than the freshness window; ERROR = the last attempt failed. */
export type VerifyState = "VERIFIED" | "PARTIAL" | "UNVERIFIED" | "STALE" | "ERROR";

export interface ColumnInfo {
  table: string;
  name: string;
  type: string;
  nullable: boolean;
}
export interface TableInfo {
  name: string;
  /** Planner estimate of rows (pg_class.reltuples); -1 when unknown. Never exact. */
  estRows: number;
  columns: string[];
  hasPrimaryKey: boolean;
}
export interface FkInfo {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  validated: boolean;
}
export interface IndexInfo {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  valid: boolean;
  primary: boolean;
}
export interface ConstraintInfo {
  name: string;
  table: string;
  kind: "unique" | "check";
}
export interface TriggerInfo {
  table: string;
  name: string;
}

/** A point-in-time copy of schema METADATA (names and counts only; never row data). */
export interface Catalog {
  collectedAt: string;
  tables: TableInfo[];
  columns: ColumnInfo[];
  foreignKeys: FkInfo[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  triggers: TriggerInfo[];
  rlsEnabledTables: string[];
  /** Tables with privileges granted to PUBLIC. */
  publicGrantTables: string[];
  /** Migration ledger table names found (e.g. schema_migrations). */
  migrationLedgers: string[];
  /** Newest version recorded in a ledger, if readable. */
  migrationLatest: string | null;
  /** Column of the ledger holding the version (needs a column grant to be read). */
  migrationLedgerColumn: string | null;
  /** True when the monitoring session proved it is read-only (transaction_read_only = on). */
  sessionReadOnly: boolean | null;
}

export interface NeonSettings {
  branchName: string | null;
  branchId: string | null;
  protected: boolean | null;
  historyRetentionSeconds: number | null;
}

export type Classification = "mandatory" | "optional" | "external" | "intentional-non-fk" | "UNVERIFIED";

export interface FkCandidate {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string | null;
  targetColumn: string | null;
  targetAmbiguous: boolean;
  cardinality: "many-to-one" | "one-to-one" | "unknown";
  classification: Classification;
  evidence: string;
  /** Verified orphan count, or null when not verifiable (no check ran). */
  orphans: number | null;
  rowsExamined: number | null;
  criticality: "high" | "medium" | "low";
  recommendedAction: string;
}

export type Severity = "P0" | "P1" | "P2" | "P3";

export interface CheckDef {
  id: string;
  version: number;
  app: AppKey;
  tables: string[];
  invariant: string;
  severity: Severity;
  /** quick = cheap, run on every Refresh; deep = full audit only. */
  tier: "quick" | "deep";
  /** Child column that must reference parent when not null. */
  child: { table: string; column: string };
  parent: { table: string; column: string };
  recommendation: string;
}

export type CheckOutcome = "PASS" | "FAIL" | "UNVERIFIED" | "ERROR";
export interface CheckResult {
  checkId: string;
  version: number;
  app: AppKey;
  tables: string[];
  invariant: string;
  severity: Severity;
  outcome: CheckOutcome;
  rowsExamined: number | null;
  failures: number | null;
  /** Query identifier (a stable hash name), never the raw SQL with data. */
  queryId: string;
  evidence: string;
  recommendation: string;
}

export interface SubScore {
  key: string;
  label: string;
  /** Points that can be earned. */
  max: number;
  /** Points earned; null = not measured (counts as 0 in the total, lowers coverage). */
  earned: number | null;
  calculation: string;
  inputs: Record<string, number | string | boolean | null>;
  source: string;
}

export interface CriterionScore {
  key: string;
  label: string;
  weight: number;
  /** 0-10 or null (N/V). */
  score: number | null;
  /** Share of possible points that were measured (0-1). */
  coverage: number;
  state: VerifyState;
  subscores: SubScore[];
  open: string[];
  capReason?: string;
}

export interface RecommendationDraft {
  id: string;
  app: AppKey;
  priority: Severity;
  issue: string;
  target: string;
  evidence: string;
  rootCause: string;
  correction: string;
  expectedImprovement: string;
  riskEffort: string;
  migrationOrCode: string;
  verificationTest: string;
  rollback: string;
  owner: string;
  /** Draft SQL proposal. Stored only; NEVER executed by secval. */
  draftSql: string | null;
}
