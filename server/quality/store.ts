import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";
import { buildBaseline, evaluate, type Baseline } from "./engine.js";
import { getSpec } from "./datasets/index.js";
import { DEFAULT_POLICY, type QualityPolicy } from "./policy.js";
import type { QualityResult, RefreshSubmission } from "./types.js";

/** Validates one refresh, saves the audit row, and (on a trustworthy result) the new baseline. */
export function validateRefresh(
  db: DB,
  sub: RefreshSubmission,
  policy: QualityPolicy = DEFAULT_POLICY,
  now: Date = new Date(),
): QualityResult {
  const spec = getSpec(sub.dataset);
  const baseline = loadBaseline(db, sub.dataset);
  const result = evaluate(spec, sub, baseline, policy, now);

  // A baseline is only ever a trustworthy snapshot: not a failed or unverified one.
  const saveBaseline = !!spec && result.outcome === "PASS" && sub.operationCompleted;
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO quality_runs (job_id, app, module, page, dataset, dataset_code, table_name, source_system, initiator, kind,
         started_at, finished_at, evaluated_at, outcome, status, score, raw_score, coverage, critical, policy_version, spec_version,
         record_count, result_json)
       VALUES (@job_id, @app, @module, @page, @dataset, @dataset_code, @table_name, @source_system, @initiator, @kind,
         @started_at, @finished_at, @evaluated_at, @outcome, @status, @score, @raw_score, @coverage, @critical, @policy_version, @spec_version,
         @record_count, @result_json)`,
    ).run({
      job_id: sub.jobId,
      app: sub.app,
      module: sub.module,
      page: sub.page,
      dataset: sub.dataset,
      dataset_code: sub.datasetCode ?? null,
      table_name: sub.table,
      source_system: sub.sourceSystem,
      initiator: sub.initiator,
      kind: sub.kind,
      started_at: sub.startedAt,
      finished_at: sub.finishedAt,
      evaluated_at: result.evaluatedAt,
      outcome: result.outcome,
      status: result.status,
      score: result.score,
      raw_score: result.rawScore,
      coverage: result.coverage,
      critical: result.critical ? 1 : 0,
      policy_version: result.policyVersion,
      spec_version: result.specVersion,
      record_count: result.recordCount,
      result_json: JSON.stringify(result),
    });
    if (saveBaseline && spec) {
      db.prepare(
        `INSERT INTO quality_snapshots (dataset, job_id, taken_at, record_count, fingerprints)
         VALUES (@dataset, @job_id, @taken_at, @record_count, @fp)
         ON CONFLICT(dataset) DO UPDATE SET job_id = excluded.job_id, taken_at = excluded.taken_at,
           record_count = excluded.record_count, fingerprints = excluded.fingerprints`,
      ).run({
        dataset: sub.dataset,
        job_id: sub.jobId,
        taken_at: result.evaluatedAt,
        record_count: sub.records.length,
        fp: JSON.stringify([...buildBaseline(spec, sub.records)]),
      });
    }
  });
  insert();

  appendAudit(db, {
    actor: sub.initiator,
    action: "data-quality-validation",
    target: sub.dataset,
    mode: sub.kind,
    decision: "info",
    reason: `${result.outcome} ${result.status}${result.score === null ? "" : ` ${result.score}`}`,
    detail: { jobId: sub.jobId, app: sub.app, critical: result.critical, coverage: result.coverage, policy: result.policyVersion },
  });
  return result;
}

export function loadBaseline(db: DB, dataset: string): Baseline {
  const row = db.prepare(`SELECT fingerprints FROM quality_snapshots WHERE dataset = ?`).get(dataset) as
    | { fingerprints: string }
    | undefined;
  return row ? new Map(JSON.parse(row.fingerprints) as Array<[string, string]>) : null;
}

export interface RunSummary {
  id: number;
  jobId: string;
  app: string;
  module: string;
  page: string;
  dataset: string;
  kind: string;
  outcome: string;
  status: string;
  score: number | null;
  coverage: number;
  critical: boolean;
  finishedAt: string;
  evaluatedAt: string;
  recordCount: number;
}

const COLS = `id, job_id AS jobId, app, module, page, dataset, kind, outcome, status, score, coverage, critical,
  finished_at AS finishedAt, evaluated_at AS evaluatedAt, record_count AS recordCount`;

export function listRuns(db: DB, f: { app?: string; dataset?: string; limit?: number } = {}): RunSummary[] {
  const where: string[] = [];
  const args: Record<string, unknown> = { limit: Math.min(200, Math.max(1, f.limit ?? 50)) };
  if (f.app) { where.push("app = @app"); args.app = f.app; }
  if (f.dataset) { where.push("dataset = @dataset"); args.dataset = f.dataset; }
  const rows = db
    .prepare(`SELECT ${COLS} FROM quality_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT @limit`)
    .all(args) as Array<Omit<RunSummary, "critical"> & { critical: number }>;
  return rows.map((r) => ({ ...r, critical: !!r.critical }));
}

/** Latest run of each dataset: what a status screen shows. */
export function latestPerDataset(db: DB, app?: string): RunSummary[] {
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM quality_runs q
       WHERE id = (SELECT MAX(id) FROM quality_runs WHERE dataset = q.dataset) ${app ? "AND app = @app" : ""}
       ORDER BY app, dataset`,
    )
    .all(app ? { app } : {}) as Array<Omit<RunSummary, "critical"> & { critical: number }>;
  return rows.map((r) => ({ ...r, critical: !!r.critical }));
}

export function getRun(db: DB, id: number): QualityResult | null {
  const row = db.prepare(`SELECT result_json FROM quality_runs WHERE id = ?`).get(id) as { result_json: string } | undefined;
  return row ? (JSON.parse(row.result_json) as QualityResult) : null;
}
