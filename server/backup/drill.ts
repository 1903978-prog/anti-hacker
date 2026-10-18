import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";

/**
 * Backup status and the daily restore drill. The drill restores the latest
 * Backblaze copy into a throwaway file, checks it opens and is intact, and
 * records the result, so a broken backup is noticed without anyone testing it
 * by hand. It never touches the live store.
 */

const DRILL_KEY = "backup_last_drill";
const DAY_MS = 24 * 60 * 60_000;

/** How start.sh started secval: "on" (backing up), "restore-failed", or "off". */
export type BackupMode = "on" | "restore-failed" | "off";

export interface DrillResult {
  ok: boolean;
  at: string; // ISO time
  detail: string;
  allowlistRows?: number;
}

/** Restores the backup into `outPath`; injectable for tests. */
export type RestoreFn = (outPath: string) => Promise<void>;

export function backupMode(): BackupMode {
  const m = process.env.SECVAL_BACKUP_MODE;
  return m === "on" || m === "restore-failed" ? m : "off";
}

const litestreamRestore: RestoreFn = (outPath) =>
  new Promise((resolve, reject) => {
    execFile(
      "./bin/litestream",
      ["restore", "-config", "litestream.yml", "-o", outPath, process.env.SECVAL_DB_PATH ?? ""],
      { timeout: 120_000 },
      (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()),
    );
  });

export function getLastDrill(db: DB): DrillResult | null {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(DRILL_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as DrillResult;
  } catch {
    return null;
  }
}

function saveDrill(db: DB, r: DrillResult): void {
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(DRILL_KEY, JSON.stringify(r));
}

/** Runs one restore drill and records the result (also in the audit trail). */
export async function runRestoreDrill(
  db: DB,
  actor: string,
  restore: RestoreFn = litestreamRestore,
  now: () => Date = () => new Date(),
): Promise<DrillResult> {
  const dir = mkdtempSync(join(tmpdir(), "secval-drill-"));
  const out = join(dir, "restored.sqlite");
  let result: DrillResult;
  try {
    await restore(out);
    const copy = new Database(out, { readonly: true, fileMustExist: true });
    try {
      const check = copy.pragma("integrity_check", { simple: true });
      const rows = (copy.prepare(`SELECT COUNT(*) AS n FROM allowlist`).get() as { n: number }).n;
      result =
        check === "ok"
          ? { ok: true, at: now().toISOString(), detail: "Backup restored and checked", allowlistRows: rows }
          : { ok: false, at: now().toISOString(), detail: `Restored copy is damaged: ${String(check)}` };
    } finally {
      copy.close();
    }
  } catch (err) {
    result = { ok: false, at: now().toISOString(), detail: `Restore failed: ${(err as Error).message}`.slice(0, 300) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  saveDrill(db, result);
  appendAudit(db, {
    actor,
    action: "backup.restore_drill",
    decision: "info",
    detail: { ok: result.ok, detail: result.detail },
  });
  return result;
}

export interface BackupStatus {
  mode: BackupMode;
  lastDrill: DrillResult | null;
  /** True when backups run and the last drill passed within two days. */
  healthy: boolean;
}

export function backupStatus(db: DB, now: Date = new Date()): BackupStatus {
  const mode = backupMode();
  const lastDrill = getLastDrill(db);
  const fresh = !!lastDrill && now.getTime() - Date.parse(lastDrill.at) < 2 * DAY_MS;
  return { mode, lastDrill, healthy: mode === "on" && fresh && !!lastDrill?.ok };
}

/**
 * Runs the drill a few minutes after start, then whenever the last one is a
 * day old. Only when backups are on; errors never crash the server.
 */
export function startRestoreDrill(db: DB, actor = "scheduler"): void {
  if (backupMode() !== "on") return;
  const tick = () => {
    const last = getLastDrill(db);
    if (last && Date.now() - Date.parse(last.at) < DAY_MS) return;
    runRestoreDrill(db, actor).catch(() => {
      /* recorded inside runRestoreDrill; never crash */
    });
  };
  setTimeout(tick, 5 * 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
