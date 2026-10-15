import type { DB } from "../db.js";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string | null;
  mode?: string | null;
  decision: "allow" | "deny" | "info";
  reason?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  ts: string;
}

/**
 * Appends one immutable entry to the audit trail. The trail can only grow —
 * updates and deletes are blocked by database triggers (see db.ts). Returns
 * the row id written.
 */
export function appendAudit(db: DB, entry: AuditEntry): number {
  const ts = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO audit_log (ts, actor, action, target, mode, decision, reason, detail)
       VALUES (@ts, @actor, @action, @target, @mode, @decision, @reason, @detail)`,
    )
    .run({
      ts,
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      mode: entry.mode ?? null,
      decision: entry.decision,
      reason: entry.reason ?? null,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
    });
  return Number(info.lastInsertRowid);
}

/** Returns audit entries newest-first, most recent `limit` rows. */
export function listAudit(db: DB, limit = 100): AuditRow[] {
  const rows = db
    .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    ts: r.ts as string,
    actor: r.actor as string,
    action: r.action as string,
    target: (r.target as string) ?? null,
    mode: (r.mode as string) ?? null,
    decision: r.decision as AuditEntry["decision"],
    reason: (r.reason as string) ?? null,
    detail: r.detail ? (JSON.parse(r.detail as string) as Record<string, unknown>) : null,
  }));
}
