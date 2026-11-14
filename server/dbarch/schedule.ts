import type { DB } from "../db.js";
import { APPS, STALE_AFTER_MS } from "./apps.js";
import { checkStaleness, runScan, type Deps } from "./engine.js";
import type { AppKey } from "./types.js";

/**
 * In-process timers: Quick Refresh every 6 h, Deep Audit every 24 h (both
 * configurable). A restart does not re-run a tier that is still fresh. This
 * is scheduled polling, not continuous streaming. No e-mail is ever sent.
 */
export function startDbarchScheduler(db: DB, deps: Deps): (() => void) | null {
  const configured = (Object.keys(APPS) as AppKey[]).filter((a) => deps.env[APPS[a].envVar]);
  if (!configured.length) {
    // eslint-disable-next-line no-console
    console.log("secval: database scorecard has no read-only connection configured; values stay N/V.");
    return null;
  }
  const hours = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  const quickMs = hours(deps.env.SECVAL_DBARCH_QUICK_HOURS, 6) * 3_600_000;
  const deepMs = hours(deps.env.SECVAL_DBARCH_DEEP_HOURS, 24) * 3_600_000;
  const tick = async () => {
    try {
      for (const app of configured) {
        for (const [tier, every] of [["deep", deepMs], ["quick", quickMs]] as const) {
          const last = db.prepare(`SELECT finished_at FROM dbarch_scans WHERE app = ? AND tier = ? ORDER BY id DESC LIMIT 1`).get(app, tier) as { finished_at: string } | undefined;
          if (!last || deps.now().getTime() - Date.parse(last.finished_at) >= every) {
            await runScan(db, app, tier, deps);
            break; // one scan per app per tick; deep covers quick
          }
        }
      }
      checkStaleness(db, deps, STALE_AFTER_MS);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("secval: dbarch tick failed:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
    }
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, 10 * 60_000);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
