import type Database from "better-sqlite3";
import { listAllowlist } from "../ownership/allowlist.js";
import { parseAppTokens } from "../middleware.js";
import { getLastDrill } from "../backup/drill.js";

type DB = Database.Database;

/**
 * Public, secret-free facts about secval's measurement links (08 Nov 2026,
 * five-app certification P0): which build is live, whether the database-check
 * token and the per-app quality tokens are configured (yes/no and app names,
 * never a value), and when each app last answered. No score, no rule note, no
 * error text: only a coarse outcome, so the page reveals nothing about an
 * app's weaknesses.
 */
export interface MeasurementStatus {
  commit: string | null;
  dbCheckTokenSet: boolean;
  qualityTokenApps: string[];
  databases: Array<{ host: string; lastCheckAt: string | null; outcome: "measured" | "refused" | "stale" | "bad-answer" | "unreachable" | "none" }>;
  quality: Array<{ app: string; lastRunAt: string | null }>;
  /** Secval's own backup: mode and the last restore drill (time and pass/fail, no detail). */
  backup: { mode: string; lastDrillAt: string | null; lastDrillOk: boolean | null };
}

export function outcomeOf(ok: boolean | null, error: string | null): MeasurementStatus["databases"][number]["outcome"] {
  if (ok === null) return "none";
  if (ok) return "measured";
  const e = error ?? "";
  if (/^status 40[13]\b/.test(e)) return "refused";
  if (/stale|future/.test(e)) return "stale";
  if (/^bad report|too big|JSON/.test(e)) return "bad-answer";
  return "unreachable";
}

export function measurementStatus(db: DB, env: NodeJS.ProcessEnv = process.env): MeasurementStatus {
  const apps = [...parseAppTokens(env.SECVAL_QUALITY_TOKENS).keys()].sort();
  const lastCheck = db.prepare(`SELECT ts, ok, error FROM db_checks WHERE host = ? ORDER BY id DESC LIMIT 1`);
  const lastRun = db.prepare(`SELECT max(started_at) AS at FROM quality_runs WHERE app = ?`);
  const databases = listAllowlist(db)
    .filter((e) => e.ownershipProven)
    .map((e) => {
      const r = lastCheck.get(e.domain) as { ts: string; ok: number; error: string | null } | undefined;
      return { host: e.domain, lastCheckAt: r?.ts ?? null, outcome: outcomeOf(r ? r.ok === 1 : null, r?.error ?? null) };
    });
  return {
    commit: (env.RENDER_GIT_COMMIT ?? "").slice(0, 12) || null,
    dbCheckTokenSet: !!env.SECVAL_DBCHECK_TOKEN,
    qualityTokenApps: apps,
    databases,
    quality: apps.map((app) => ({ app, lastRunAt: (lastRun.get(app) as { at: string | null }).at })),
    backup: (() => {
      const d = getLastDrill(db);
      const m = env.SECVAL_BACKUP_MODE;
      return { mode: m === "on" || m === "restore-failed" ? m : "off", lastDrillAt: d?.at ?? null, lastDrillOk: d ? d.ok : null };
    })(),
  };
}
