/**
 * SecVal Data Quality Engine: shared types.
 *
 * An app sends a RefreshSubmission after every Refresh / Pull / Sync / Import /
 * Reload. The engine returns a QualityResult. Everything is deterministic:
 * the same submission and the same policy always give the same score.
 */

export type DimensionId =
  | "accuracy"
  | "completeness"
  | "referential"
  | "freshness"
  | "consistency"
  | "uniqueness"
  | "validity"
  | "provenance"
  | "change"
  | "access";

export const DIMENSIONS: DimensionId[] = [
  "accuracy",
  "completeness",
  "referential",
  "freshness",
  "consistency",
  "uniqueness",
  "validity",
  "provenance",
  "change",
  "access",
];

export type Severity = "critical" | "major" | "minor";

/** What the Refresh button actually did (a UI reload is not a new ingestion). */
export type RefreshKind = "external_fetch" | "sync" | "import" | "recompute" | "cache" | "reload";

export type Row = Record<string, unknown>;

export interface RefreshSubmission {
  jobId: string;
  app: string;
  module: string;
  page: string;
  /** Registered dataset id, e.g. "compplan.employees". */
  dataset: string;
  datasetCode?: string;
  /** Actual PostgreSQL table identity (schema.table). */
  table: string;
  sourceSystem: string;
  initiator: string;
  kind: RefreshKind;
  startedAt: string;
  finishedAt: string;
  /** The app's own job finished without error. */
  operationCompleted: boolean;
  /** true = source reached, false = not reached, null/absent = no source involved. */
  sourceReached?: boolean | null;
  /** Source independently confirmed it has nothing new (e.g. 304, same ETag, same upstream version). */
  sourceUnchangedConfirmed?: boolean;
  previousSuccessAt?: string | null;
  records: Row[];
  /** Key sets of parent datasets, by reference name (see DatasetSpec.refs). */
  references?: Record<string, Array<string | number>>;
  /** Authoritative values by record key (see DatasetSpec.accuracy). */
  authoritative?: Record<string, Row>;
  /** Refresh permissions and data-access checks done by the app. */
  access?: { initiatorAuthorized?: boolean | null; violations?: string[] };
  /** Changes the source legitimately explains (e.g. a delisting of 3 records). */
  expectedChange?: { added?: number; removed?: number; note?: string };
}

export type FieldType = "string" | "number" | "integer" | "boolean" | "date";

export interface FieldSpec {
  name: string;
  type?: FieldType;
  /** Must be present and non-empty. */
  required?: boolean;
  /** Severity if a required field is missing (default major). */
  requiredSeverity?: Severity;
  min?: number;
  max?: number;
  pattern?: string;
  oneOf?: Array<string | number>;
}

export type ConsistencyRule =
  | { name: string; kind: "lte"; a: string; b: string; severity?: Severity }
  | { name: string; kind: "equals"; a: string; b: string; tolerance?: number; severity?: Severity }
  | { name: string; kind: "sum"; parts: string[]; total: string; tolerance?: number; severity?: Severity };

export interface DatasetSpec {
  id: string;
  app: string;
  title: string;
  /** Spec version, recorded in every run. */
  version: string;
  /** Fields that form the business identity of a record. */
  keyFields: string[];
  /** Records are expected: zero records is a FAIL, not a pass. */
  minRecords?: number;
  fields: FieldSpec[];
  /** Foreign keys. `reference` names an entry in submission.references. */
  refs?: Array<{ field: string; reference: string; nullable?: boolean }>;
  freshness?: { field?: string; maxAgeHours: number };
  consistency?: ConsistencyRule[];
  /** Accuracy: compare these fields with submission.authoritative. */
  accuracy?: { fields: string[]; relTolerance?: number };
  provenance?: { fields: string[] };
  change?: {
    maxRemovedPct: number;
    maxChangedPct: number;
    maxCountJumpPct: number;
    /** Volatile fields left out of the row fingerprint. */
    ignoreFields?: string[];
  };
  /** Dimensions that do not apply, with the documented reason. Weights are renormalized for these only. */
  notApplicable?: Partial<Record<DimensionId, string>>;
}

export interface Issue {
  dimension: DimensionId;
  severity: Severity;
  code: string;
  message: string;
  count?: number;
  total?: number;
  /** Up to 5 record keys, never values. */
  sample?: string[];
}

export interface DimensionResult {
  id: DimensionId;
  weight: number;
  state: "scored" | "unverified" | "not_applicable";
  score: number | null;
  reason?: string;
  checked: number;
  issues: Issue[];
}

export interface Reconciliation {
  baseline: boolean;
  before: number;
  after: number;
  added: number;
  removed: number;
  updated: number;
  unchanged: number;
  /** Counts only (never values). */
  unexplainedRemoved: number;
  unexplainedAdded: number;
}

export type QualityStatus = "Excellent" | "Good" | "Needs Attention" | "Poor" | "Critical" | "UNVERIFIED";

export interface QualityResult {
  jobId: string;
  policyVersion: string;
  specVersion: string | null;
  app: string;
  dataset: string;
  /** PASS = trustworthy, FAIL = operation failed or critical breach, UNVERIFIED = not enough evidence. */
  outcome: "PASS" | "FAIL" | "UNVERIFIED";
  status: QualityStatus;
  /** 0-100, or null when UNVERIFIED. Unverified dimensions count 0 in it (never silently dropped). */
  score: number | null;
  /** Score before the critical cap. */
  rawScore: number | null;
  /** Share of the applicable weight that was actually verified (0-1). */
  coverage: number;
  critical: boolean;
  criticalReasons: string[];
  dimensions: DimensionResult[];
  reconciliation: Reconciliation | null;
  issues: Issue[];
  evaluatedAt: string;
  recordCount: number;
}
