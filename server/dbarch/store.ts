import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";
import type { AppKey } from "./types.js";
import type { Attestations } from "./scoring.js";

export interface ScanRow {
  id: number; app: AppKey; tier: "quick" | "deep"; started_at: string; finished_at: string;
  status: "ok" | "partial" | "error"; error_label: string | null; calc_version: string; fingerprint: string | null;
  arch_score: number | null; arch_coverage: number | null; ready_score: number | null; ready_coverage: number | null; summary_json: string;
}

export function insertScan(db: DB, r: Omit<ScanRow, "id">): number {
  return Number(
    db.prepare(
      `INSERT INTO dbarch_scans (app,tier,started_at,finished_at,status,error_label,calc_version,fingerprint,arch_score,arch_coverage,ready_score,ready_coverage,summary_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(r.app, r.tier, r.started_at, r.finished_at, r.status, r.error_label, r.calc_version, r.fingerprint, r.arch_score, r.arch_coverage, r.ready_score, r.ready_coverage, r.summary_json).lastInsertRowid,
  );
}

export function recentScans(db: DB, app: AppKey, limit = 60): ScanRow[] {
  return db.prepare(`SELECT * FROM dbarch_scans WHERE app = ? ORDER BY id DESC LIMIT ?`).all(app, limit) as ScanRow[];
}
export function lastSuccessful(db: DB, app: AppKey): ScanRow | null {
  return (db.prepare(`SELECT * FROM dbarch_scans WHERE app = ? AND status IN ('ok','partial') ORDER BY id DESC LIMIT 1`).get(app) as ScanRow | undefined) ?? null;
}
export function firstSuccessful(db: DB, app: AppKey): ScanRow | null {
  return (db.prepare(`SELECT * FROM dbarch_scans WHERE app = ? AND status IN ('ok','partial') ORDER BY id ASC LIMIT 1`).get(app) as ScanRow | undefined) ?? null;
}
export function consecutiveFailures(db: DB, app: AppKey): number {
  const rows = db.prepare(`SELECT status FROM dbarch_scans WHERE app = ? ORDER BY id DESC LIMIT 10`).all(app) as { status: string }[];
  let n = 0;
  for (const r of rows) { if (r.status === "error") n++; else break; }
  return n;
}

export function saveLatest(db: DB, app: AppKey, scanId: number, updatedAt: string, deepAt: string | null, resultJson: string): void {
  db.prepare(
    `INSERT INTO dbarch_latest (app,scan_id,updated_at,deep_at,result_json) VALUES (?,?,?,?,?)
     ON CONFLICT(app) DO UPDATE SET scan_id=excluded.scan_id, updated_at=excluded.updated_at, deep_at=COALESCE(excluded.deep_at, dbarch_latest.deep_at), result_json=excluded.result_json`,
  ).run(app, scanId, updatedAt, deepAt, resultJson);
}
export function getLatest(db: DB, app: AppKey): { scan_id: number; updated_at: string; deep_at: string | null; result: Record<string, unknown> } | null {
  const r = db.prepare(`SELECT scan_id, updated_at, deep_at, result_json FROM dbarch_latest WHERE app = ?`).get(app) as
    | { scan_id: number; updated_at: string; deep_at: string | null; result_json: string } | undefined;
  return r ? { scan_id: r.scan_id, updated_at: r.updated_at, deep_at: r.deep_at, result: JSON.parse(r.result_json) } : null;
}

export interface AlertRow { id: number; app: string; scan_id: number | null; kind: string; severity: string; message: string; created_at: string }
export function addAlert(db: DB, a: { app: AppKey; scanId: number | null; kind: string; severity: string; message: string }, now: string): void {
  db.prepare(`INSERT INTO dbarch_alerts (app,scan_id,kind,severity,message,created_at) VALUES (?,?,?,?,?,?)`).run(a.app, a.scanId, a.kind, a.severity, a.message, now);
  // In-app only: the shared audit trail. No e-mail is sent by this module.
  appendAudit(db, { actor: "dbarch", action: `dbarch.alert.${a.kind}`, target: a.app, decision: "info", reason: a.message.slice(0, 300) });
}
export function listAlerts(db: DB, app?: AppKey, limit = 100): AlertRow[] {
  return (app
    ? db.prepare(`SELECT * FROM dbarch_alerts WHERE app = ? ORDER BY id DESC LIMIT ?`).all(app, limit)
    : db.prepare(`SELECT * FROM dbarch_alerts ORDER BY id DESC LIMIT ?`).all(limit)) as AlertRow[];
}
export function recentAlertOfKind(db: DB, app: AppKey, kind: string, sinceIso: string): boolean {
  return !!db.prepare(`SELECT 1 FROM dbarch_alerts WHERE app = ? AND kind = ? AND created_at >= ?`).get(app, kind, sinceIso);
}

export interface AttestationRow { id: number; app: string; key: string; value: number | null; detail: string | null; reason: string; approved_by: string; created_at: string; expires_at: string | null }
const KEYS = /^(authz_review|restore_test|independent_verify|schema_ack|override:[a-z_]+)$/;
export function validAttestationKey(k: string): boolean { return KEYS.test(k); }

export function addAttestation(db: DB, a: { app: AppKey; key: string; value: number | null; detail?: string | null; reason: string; approvedBy: string; expiresAt: string | null }, now: string): void {
  db.prepare(`INSERT INTO dbarch_attestations (app,key,value,detail,reason,approved_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)`).run(
    a.app, a.key, a.value, a.detail ?? null, a.reason, a.approvedBy, now, a.expiresAt,
  );
  appendAudit(db, { actor: a.approvedBy, action: "dbarch.attestation", target: a.app, decision: "info", reason: `${a.key}=${a.value ?? ""} until ${a.expiresAt ?? "n/a"}: ${a.reason}`.slice(0, 300) });
}
/** Latest non-expired attestation per key. */
export function activeAttestations(db: DB, app: AppKey, now: Date): Map<string, AttestationRow> {
  const rows = db.prepare(`SELECT * FROM dbarch_attestations WHERE app = ? ORDER BY id ASC`).all(app) as AttestationRow[];
  const m = new Map<string, AttestationRow>();
  for (const r of rows) {
    if (r.expires_at && Date.parse(r.expires_at) <= now.getTime()) { m.delete(r.key); continue; }
    m.set(r.key, r);
  }
  return m;
}
export function attestationsFrom(m: Map<string, AttestationRow>): Attestations {
  return {
    authzReview: m.get("authz_review")?.value ?? null,
    restoreTest: m.get("restore_test")?.value ?? null,
    independentlyVerified: (m.get("independent_verify")?.value ?? 0) >= 1,
  };
}
