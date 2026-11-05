import type { DB } from "../db.js";
import { APPS, CALC_VERSION, HISTORICAL_BASELINE, TARGETS } from "./apps.js";
import { collectCatalog, schemaFingerprint } from "./catalog.js";
import { ConnectError, type Connector, type Session } from "./connect.js";
import { buildChecks, runChecks } from "./checks.js";
import { buildInventory } from "./inventory.js";
import { readNeonSettings, type FetchFn } from "./neon.js";
import { buildRecommendations, isComplete, lintDraftSql } from "./recommendations.js";
import type { NetOps } from "./connectivity.js";
import { verifyPermissions, type PermissionReport } from "./permissions.js";
import { overallFrom, readinessOverall, scoreArchitecture, scoreReadiness, type Evidence, type SchemaChange } from "./scoring.js";
import {
  activeAttestations, addAlert, attestationsFrom, consecutiveFailures, firstSuccessful, getLatest, insertScan, lastSuccessful, recentAlertOfKind, saveLatest,
} from "./store.js";
import type { AppKey, Catalog, CheckResult, CriterionScore, FkCandidate, NeonSettings, RecommendationDraft } from "./types.js";

export interface Deps {
  connect: Connector;
  neonFetch?: FetchFn;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** DNS/TCP probes for the connectivity test (tests hand in fakes). */
  net?: NetOps;
}

export type StoredCheck = CheckResult & { ranAt: string; carried?: boolean };

export interface AppResult {
  app: AppKey;
  label: string;
  projectId: string;
  collectedAt: string;
  tier: "quick" | "deep";
  calcVersion: string;
  fingerprint: string;
  schemaChange: SchemaChange;
  architecture: { score: number | null; coverage: number; state: string; criteria: CriterionScore[] };
  readiness: { score: number | null; coverage: number; state: string; rows: CriterionScore[] };
  catalog: { tables: number; primaryKeys: number; foreignKeys: number; indexes: number; idColumnsWithoutFk: number; rlsTables: number; uniqueOrCheck: number; migrationLedgers: string[]; migrationLatest: string | null; sessionReadOnly: boolean | null };
  neon: NeonSettings | null;
  permissions: PermissionReport | null;
  reconcile: Array<{ metric: string; reference: number | boolean | null; live: number | boolean | null; matches: boolean | null }>;
  inventory: FkCandidate[];
  checks: StoredCheck[];
  recommendations: RecommendationDraft[];
}

export type ScanOutcome =
  | { app: AppKey; status: "unconfigured"; message: string }
  | { app: AppKey; status: "skipped"; message: string }
  | { app: AppKey; status: "error"; message: string }
  | { app: AppKey; status: "ok" | "partial"; scanId: number; alerts: number };

const running = new Set<string>();
const DEDUPE_MS = 60_000;
const DEEP_VALID_H = 48;

function reconcile(app: AppKey, c: AppResult["catalog"], neon: NeonSettings | null): AppResult["reconcile"] {
  const ref = HISTORICAL_BASELINE.metrics[app];
  const rows: AppResult["reconcile"] = [];
  const num = (metric: string, reference: number, live: number) => {
    const tol = Math.max(1, Math.round(reference * 0.05));
    rows.push({ metric, reference, live, matches: Math.abs(reference - live) <= tol });
  };
  num("Public tables", ref.tables as number, c.tables);
  num("Primary keys", ref.primaryKeys as number, c.primaryKeys);
  num("Foreign keys", ref.foreignKeys as number, c.foreignKeys);
  num("Indexes", ref.indexes as number, c.indexes);
  num("_id columns without FK", ref.idColumnsWithoutFk as number, c.idColumnsWithoutFk);
  num("RLS-enabled tables", ref.rlsTables as number, c.rlsTables);
  rows.push({ metric: "Production branch protected", reference: ref.branchProtected as boolean, live: neon?.protected ?? null, matches: neon?.protected == null ? null : neon.protected === ref.branchProtected });
  rows.push({ metric: "Neon history retention (h)", reference: ref.retentionHours as number, live: neon?.historyRetentionSeconds == null ? null : neon.historyRetentionSeconds / 3600, matches: neon?.historyRetentionSeconds == null ? null : neon.historyRetentionSeconds / 3600 === ref.retentionHours });
  return rows;
}

function compact(r: AppResult, alerts: number) {
  const cs = (cs: CriterionScore[]) => cs.map((c) => ({ key: c.key, score: c.score, coverage: c.coverage, state: c.state }));
  return {
    architecture: { score: r.architecture.score, coverage: r.architecture.coverage, criteria: cs(r.architecture.criteria) },
    readiness: { score: r.readiness.score, coverage: r.readiness.coverage, rows: cs(r.readiness.rows) },
    counts: r.catalog,
    openFindings: r.recommendations.reduce((a, x) => ({ ...a, [x.priority]: (a[x.priority] ?? 0) + 1 }), {} as Record<string, number>),
    failedChecks: r.checks.filter((c) => c.outcome === "FAIL").map((c) => ({ id: c.checkId, failures: c.failures })),
    schemaChange: r.schemaChange,
    neon: r.neon,
    alerts,
    findingIds: r.recommendations.map((x) => x.id),
  };
}

export async function runScan(db: DB, app: AppKey, tier: "quick" | "deep", deps: Deps): Promise<ScanOutcome> {
  const cfg = APPS[app];
  const conn = deps.env[cfg.envVar]?.trim();
  if (!conn) return { app, status: "unconfigured", message: `Read-only connection not configured (${cfg.envVar} is not set). All values are N/V.` };
  if (running.has(app)) return { app, status: "skipped", message: "A scan of this app is already running." };

  const startedAt = deps.now();
  const prevOk = lastSuccessful(db, app);
  // Idempotent: a repeated click within a minute reuses the scan just stored.
  if (prevOk && prevOk.tier === tier && startedAt.getTime() - Date.parse(prevOk.finished_at) < DEDUPE_MS) {
    return { app, status: "skipped", message: "A scan finished less than a minute ago; showing it." };
  }
  running.add(app);
  let session: Session | null = null;
  try {
    session = await deps.connect(conn);
    // Fail closed: if the login can write, change schema or has admin rights, nothing is scanned.
    const permissions = await verifyPermissions(session, startedAt);
    if (permissions.leastPrivilege === false) throw new ConnectError("monitoring login has privileges it must not have; scan refused");
    const cat: Catalog = await collectCatalog(session, startedAt);
    const neon = await readNeonSettings(cfg.neonProjectId, deps.env.SECVAL_NEON_API_TOKEN, deps.neonFetch);
    const inventory = buildInventory(app, cat);
    const defs = buildChecks(app, cat, inventory);
    const fresh = await runChecks(session, cat, defs, { tier, deadline: startedAt.getTime() + (tier === "deep" ? 300_000 : 60_000) });

    const previous = getLatest(db, app);
    const prev = previous?.result as unknown as AppResult | undefined;
    const iso = startedAt.toISOString();
    const checks: StoredCheck[] = fresh.map((c) => ({ ...c, ranAt: iso }));
    const deepFresh = tier === "deep" || (previous?.deep_at != null && startedAt.getTime() - Date.parse(previous.deep_at) <= DEEP_VALID_H * 3_600_000);
    if (tier === "quick" && deepFresh && prev) {
      const have = new Set(checks.filter((c) => c.outcome !== "UNVERIFIED" || !c.evidence.startsWith("Skipped")).map((c) => c.checkId));
      const stillDefined = new Set(defs.map((d) => d.id));
      for (const old of prev.checks) {
        if (!stillDefined.has(old.checkId)) continue;
        const idx = checks.findIndex((c) => c.checkId === old.checkId);
        if (idx >= 0 && have.has(old.checkId)) continue;
        const carried = { ...old, carried: true, evidence: old.carried ? old.evidence : `${old.evidence} (from deep audit ${old.ranAt})` };
        if (idx >= 0) checks[idx] = carried; else checks.push(carried);
      }
    }
    for (const c of inventory) {
      const r = checks.find((x) => x.checkId === `orph:${c.sourceTable}.${c.sourceColumn}`);
      if (r && r.outcome !== "ERROR" && r.failures !== null) { c.orphans = r.failures; c.rowsExamined = r.rowsExamined; }
    }

    const fingerprint = schemaFingerprint(cat);
    const attest = activeAttestations(db, app, startedAt);
    const baselineScan = firstSuccessful(db, app);
    const ack = attest.get("schema_ack")?.detail ?? null;
    const baselineFp = ack ?? baselineScan?.fingerprint ?? null;
    const schemaChange: SchemaChange = baselineFp === null ? "first" : baselineFp === fingerprint ? "unchanged" : ack === fingerprint ? "approved" : "changed";

    const recs = buildRecommendations({ app, cat, inventory, checks, neon });
    const needs = recs.filter((r) => r.id.startsWith("fk:") || r.id.startsWith("idx:"));
    const drafts = recs.filter((r) => r.draftSql);
    const deepAt = tier === "deep" ? iso : previous?.deep_at ?? null;
    const ev: Evidence = {
      cat, inventory, checksDefined: defs.length, checks, neon, schemaChange,
      deepAuditAgeHours: deepAt ? (startedAt.getTime() - Date.parse(deepAt)) / 3_600_000 : null,
      attest: attestationsFrom(attest),
      recommendationsTotal: recs.length, recommendationsComplete: recs.filter(isComplete).length,
      draftsTotal: drafts.length, draftsSafe: drafts.filter((r) => lintDraftSql(r.draftSql!).ok && isComplete(r)).length,
      needsMigration: needs.length, hasPrevious: prevOk !== null, permissions,
    };
    const criteria = scoreArchitecture(ev);
    const arch = overallFrom(criteria);
    const catSummary: AppResult["catalog"] = {
      tables: cat.tables.length, primaryKeys: cat.tables.filter((t) => t.hasPrimaryKey).length, foreignKeys: cat.foreignKeys.length, indexes: cat.indexes.length,
      idColumnsWithoutFk: inventory.length, rlsTables: cat.rlsEnabledTables.length, uniqueOrCheck: cat.constraints.length,
      migrationLedgers: cat.migrationLedgers, migrationLatest: cat.migrationLatest, sessionReadOnly: cat.sessionReadOnly,
    };
    const rec = reconcile(app, catSummary, neon);
    const ready = scoreReadiness(ev, { matched: rec.filter((r) => r.matches === true).length, compared: rec.filter((r) => r.matches !== null).length }, arch.coverage);
    const rd = readinessOverall(ready);

    const result: AppResult = {
      app, label: cfg.label, projectId: cfg.neonProjectId, collectedAt: iso, tier, calcVersion: CALC_VERSION, fingerprint, schemaChange,
      architecture: { ...arch, criteria }, readiness: { ...rd, rows: ready }, catalog: catSummary, neon, permissions, reconcile: rec, inventory, checks, recommendations: recs,
    };

    const partial = !neon || checks.some((c) => c.outcome === "ERROR") || arch.coverage < 1;
    const alerts = deriveAlerts(app, result, prev ?? null, prevOk?.arch_score ?? null);
    const scanId = insertScan(db, {
      app, tier, started_at: iso, finished_at: deps.now().toISOString(), status: partial ? "partial" : "ok", error_label: null, calc_version: CALC_VERSION,
      fingerprint, arch_score: arch.score, arch_coverage: arch.coverage, ready_score: rd.score, ready_coverage: rd.coverage,
      summary_json: JSON.stringify(compact(result, alerts.length)),
    });
    saveLatest(db, app, scanId, iso, deepAt, JSON.stringify(result));
    for (const a of alerts) addAlert(db, { app, scanId, ...a }, iso);
    return { app, status: partial ? "partial" : "ok", scanId, alerts: alerts.length };
  } catch (err) {
    const label = err instanceof ConnectError ? err.message : "scan failed (details withheld)";
    if (label.startsWith("monitoring login has privileges")) {
      addAlert(db, { app, scanId: null, kind: "role-too-privileged", severity: "P0", message: "The monitoring login has write, DDL or admin privileges. Scans are refused until it is fixed." }, deps.now().toISOString());
    }
    const iso = deps.now().toISOString();
    insertScan(db, {
      app, tier, started_at: startedAt.toISOString(), finished_at: iso, status: "error", error_label: label, calc_version: CALC_VERSION, fingerprint: null,
      arch_score: null, arch_coverage: null, ready_score: null, ready_coverage: null, summary_json: "{}",
    });
    if (consecutiveFailures(db, app) >= 3 && !recentAlertOfKind(db, app, "scan-failures", new Date(startedAt.getTime() - 24 * 3_600_000).toISOString())) {
      addAlert(db, { app, scanId: null, kind: "scan-failures", severity: "P1", message: `Database scans have failed ${consecutiveFailures(db, app)} times in a row. Scores are stale.` }, iso);
    }
    return { app, status: "error", message: label };
  } finally {
    running.delete(app);
    if (session) await session.close();
  }
}


export function deriveAlerts(app: AppKey, cur: AppResult, prev: AppResult | null, prevScore: number | null): Array<{ kind: string; severity: string; message: string }> {
  const out: Array<{ kind: string; severity: string; message: string }> = [];
  const failMap = (r: AppResult | null) => new Map((r?.checks ?? []).filter((c) => c.outcome === "FAIL").map((c) => [c.checkId, c.failures ?? 0]));
  const was = failMap(prev), now = failMap(cur);
  for (const [id, n] of now) {
    const before = was.get(id);
    const c = cur.checks.find((x) => x.checkId === id)!;
    if (before === undefined || n > before) {
      out.push({ kind: "new-orphans", severity: c.severity, message: `${id}: ${n} orphan row(s)${before === undefined ? " (new failure)" : ` (was ${before})`}.` });
      if (c.severity === "P0" && before === undefined) out.push({ kind: "critical-integrity", severity: "P0", message: `Critical integrity check failed: ${c.invariant}.` });
    }
  }
  if (prev) {
    if (cur.catalog.foreignKeys < prev.catalog.foreignKeys) out.push({ kind: "fk-lost", severity: "P0", message: `Foreign keys dropped from ${prev.catalog.foreignKeys} to ${cur.catalog.foreignKeys}.` });
    if (cur.catalog.primaryKeys < prev.catalog.primaryKeys) out.push({ kind: "pk-lost", severity: "P0", message: `Tables with a primary key dropped from ${prev.catalog.primaryKeys} to ${cur.catalog.primaryKeys}.` });
    if (prev.neon?.protected === true && cur.neon?.protected === false) out.push({ kind: "branch-protection-off", severity: "P0", message: "Production branch protection was disabled." });
  }
  if (cur.schemaChange === "changed") out.push({ kind: "unapproved-schema-change", severity: "P1", message: "Schema changed since the approved baseline and has not been acknowledged." });
  const retH = cur.neon?.historyRetentionSeconds != null ? cur.neon.historyRetentionSeconds / 3600 : null;
  const prevRetH = prev?.neon?.historyRetentionSeconds != null ? prev.neon.historyRetentionSeconds / 3600 : null;
  if (retH !== null && retH < 24 && (prevRetH === null || prevRetH >= 24)) out.push({ kind: "recovery-below-threshold", severity: "P1", message: `Neon history retention is ${retH.toFixed(1)} h (threshold 24 h).` });
  if (cur.architecture.score !== null && prevScore !== null && prevScore - cur.architecture.score >= 0.5) {
    out.push({ kind: "score-drop", severity: "P1", message: `Architecture quality fell from ${prevScore} to ${cur.architecture.score}.` });
  }
  return out;
}

export async function runAll(db: DB, tier: "quick" | "deep", deps: Deps): Promise<ScanOutcome[]> {
  const out: ScanOutcome[] = [];
  for (const app of Object.keys(APPS) as AppKey[]) out.push(await runScan(db, app, tier, deps));
  return out;
}

/** Stale-monitoring alert: configured app whose last good scan is older than the freshness window. */
export function checkStaleness(db: DB, deps: Pick<Deps, "env" | "now">, staleMs: number): void {
  const now = deps.now();
  for (const app of Object.keys(APPS) as AppKey[]) {
    if (!deps.env[APPS[app].envVar]) continue;
    const last = lastSuccessful(db, app);
    if (!last) continue;
    if (now.getTime() - Date.parse(last.finished_at) > staleMs && !recentAlertOfKind(db, app, "stale", new Date(now.getTime() - 24 * 3_600_000).toISOString())) {
      addAlert(db, { app, scanId: null, kind: "stale", severity: "P2", message: `No successful scan since ${last.finished_at}. Scores are stale.` }, now.toISOString());
    }
  }
}

export { TARGETS };
