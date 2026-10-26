import type { DB } from "../db.js";
import { listAllowlist } from "../ownership/allowlist.js";
import { runPassiveScan, type ScanResult } from "../scan/passive.js";
import { appendAudit } from "../audit/log.js";
import { newFindings, sendAlerts, type NewFinding, type AlertOutcome } from "../notify/alerts.js";

/** The scan function the sweep uses; injectable for tests. */
export type ScanFn = (db: DB, req: { actor: string; target: string }) => Promise<ScanResult>;

/**
 * Weekly schedule configuration. Default: every Monday at 08:00 Europe/Paris
 * (CET/CEST — DST is handled by the timezone database, so it stays 8am local
 * year-round).
 */
export interface WeeklyConfig {
  timeZone: string;
  weekday: string; // e.g. "Monday"
  hour: number; // local hour, 0-23
}

export const DEFAULT_WEEKLY: WeeklyConfig = {
  timeZone: "Europe/Paris",
  weekday: "Monday",
  hour: 8,
};

const LAST_RUN_KEY = "weekly_last_run";

interface LocalParts {
  weekday: string;
  hour: number;
  dateKey: string; // YYYY-MM-DD in the configured zone
}

function localParts(now: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday ?? "",
    hour: Number(parts.hour ?? "0") % 24,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * The local date (YYYY-MM-DD) of the most recent weekly slot at or before
 * `now`, or null when it cannot be found (bad config).
 */
export function latestSlotKey(now: Date, cfg: WeeklyConfig = DEFAULT_WEEKLY): string | null {
  for (let d = 0; d <= 7; d++) {
    const p = localParts(new Date(now.getTime() - d * 24 * 60 * 60_000), cfg.timeZone);
    if (p.weekday !== cfg.weekday) continue;
    if (d === 0 && p.hour < cfg.hour) continue; // today's slot has not started yet
    return p.dateKey;
  }
  return null;
}

/**
 * Decides whether the weekly sweep is due. It becomes due on the first check
 * at or after the configured weekday/hour (local time) whose date has not
 * already been run. If the server was asleep at that moment (Render's free
 * tier sleeps when idle), the missed sweep runs on the first check after it
 * wakes, any day of the week, so a sleeping server never skips a week. A
 * brand-new store (never run) waits for the next real slot. Returns the slot
 * key to record when a run happens.
 */
export function isWeeklyDue(
  now: Date,
  lastRunKey: string | null,
  cfg: WeeklyConfig = DEFAULT_WEEKLY,
): { due: boolean; key: string | null } {
  const { weekday, hour, dateKey } = localParts(now, cfg.timeZone);
  const inSlot = weekday === cfg.weekday && hour >= cfg.hour;
  if (lastRunKey === null) return inSlot ? { due: true, key: dateKey } : { due: false, key: null };
  const slot = latestSlotKey(now, cfg);
  if (!slot) return { due: false, key: null };
  return { due: lastRunKey < slot, key: slot };
}

export interface SweepResult {
  scanned: number;
  skipped: number;
  totalFindings: number;
  /** Findings not seen in the previous scan of the same site. */
  newFindings: number;
  /** What happened to the alert e-mail for those new findings. */
  alert: AlertOutcome;
}

/**
 * Scans every ownership-proven allowlist target in passive mode. Each scan
 * still passes through the policy gate; unproven targets are skipped.
 */
export async function runWeeklySweep(
  db: DB,
  actor = "scheduler",
  scan: ScanFn = runPassiveScan,
  alert: (db: DB, items: NewFinding[], actor: string) => Promise<AlertOutcome> = sendAlerts,
): Promise<SweepResult> {
  const targets = listAllowlist(db).filter((e) => e.ownershipProven);
  const all = listAllowlist(db);
  appendAudit(db, {
    actor,
    action: "schedule.sweep_start",
    decision: "info",
    detail: { eligible: targets.length },
  });

  let scanned = 0;
  let totalFindings = 0;
  const fresh: NewFinding[] = [];
  for (const t of targets) {
    const result = await scan(db, { actor, target: t.domain });
    if (result.status === "completed") {
      scanned++;
      totalFindings += result.findings.length;
      fresh.push(
        ...newFindings(db, { host: result.host ?? t.domain, scanId: result.scanId, findings: result.findings }),
      );
    }
  }
  const alertOutcome = await alert(db, fresh, actor);

  appendAudit(db, {
    actor,
    action: "schedule.sweep_complete",
    decision: "info",
    detail: { scanned, totalFindings, newFindings: fresh.length, alert: alertOutcome },
  });
  return {
    scanned,
    skipped: all.length - targets.length,
    totalFindings,
    newFindings: fresh.length,
    alert: alertOutcome,
  };
}

export function getLastRun(db: DB): string | null {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(LAST_RUN_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setLastRun(db: DB, key: string): void {
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(LAST_RUN_KEY, key);
}

/**
 * Runs one scheduler tick: if the weekly slot is due, record it and run the
 * sweep. Returns the sweep result when it ran, else null. Safe to call every
 * minute — the slot key prevents a double run within the same week.
 */
export async function tick(
  db: DB,
  now: Date = new Date(),
  cfg: WeeklyConfig = DEFAULT_WEEKLY,
  scan: ScanFn = runPassiveScan,
): Promise<SweepResult | null> {
  const { due, key } = isWeeklyDue(now, getLastRun(db), cfg);
  if (!due || !key) return null;
  setLastRun(db, key); // record first so a slow sweep cannot double-fire
  return runWeeklySweep(db, "scheduler", scan);
}

/** Starts the in-process scheduler (checks once a minute). Returns a stopper. */
export function startScheduler(db: DB, cfg: WeeklyConfig = DEFAULT_WEEKLY): () => void {
  const timer = setInterval(() => {
    void tick(db, new Date(), cfg).catch(() => {
      /* a failed sweep must not crash the server; it is logged in the trail */
    });
  }, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
