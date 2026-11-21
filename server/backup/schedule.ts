/**
 * The one weekly backup schedule (Livio, 21 Nov 2026): every Monday 08:00 Asia/Bangkok = Monday 01:00 UTC
 * (Bangkok has no daylight saving time). One code and one database generation per app per week.
 * Same rule as lm-op-model's script/lib/centralBackupCore.mjs (lastScheduledSlot, GRACE_HOURS).
 */
export const GRACE_HOURS = 12;

/** Latest Monday 01:00 UTC at or before `now`. */
export function lastScheduledSlot(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - 1 + 7) % 7));
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

/** The slot whose copy must exist now: the latest slot once its 12-hour grace has passed, else the one before it. */
export function requiredSlot(now: Date): Date {
  const s = lastScheduledSlot(now);
  if (now.getTime() >= s.getTime() + GRACE_HOURS * 3_600_000) return s;
  return lastScheduledSlot(new Date(s.getTime() - 1));
}
