import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";

const KEY = "kill_switch";

/** True when the kill switch is engaged; while engaged, no scan may start. */
export function isEngaged(db: DB): boolean {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(KEY) as
    | { value: string }
    | undefined;
  return row?.value === "engaged";
}

/** Engages the kill switch, halting all scans. Recorded in the audit trail. */
export function engage(db: DB, actor: string, reason?: string): void {
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, 'engaged')
     ON CONFLICT(key) DO UPDATE SET value = 'engaged'`,
  ).run(KEY);
  appendAudit(db, {
    actor,
    action: "kill_switch.engage",
    decision: "info",
    reason: reason ?? "kill switch engaged",
  });
}

/** Releases the kill switch so scans may resume. Recorded in the audit trail. */
export function release(db: DB, actor: string): void {
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, 'released')
     ON CONFLICT(key) DO UPDATE SET value = 'released'`,
  ).run(KEY);
  appendAudit(db, {
    actor,
    action: "kill_switch.release",
    decision: "info",
    reason: "kill switch released",
  });
}
