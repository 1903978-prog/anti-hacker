/**
 * Secval's own measurements, reused as EEES evidence (read-only, no network):
 *  - D19.1 external uptime monitor (uptime_checks, every 30 minutes)
 *  - D10.1 latest completed passive security scan (scans + findings)
 *  - D27.3 latest CI result on the deploy branch (GitHub signal cache)
 *  - D23.1 Secval's own backup restore drill (only for Secval itself)
 * Secval is a separate system from the apps it watches, so these are
 * independent of each app's own claims; they are still capped at the
 * "production" level (9) until a person reviews them over time.
 */
import type { DB } from "../db.js";
import { listUptime } from "../health/uptime.js";
import { getCiSignal } from "../health/ci.js";
import { backupStatus } from "../backup/drill.js";
import { SELF_HOST } from "../health/dbcheck.js";
import type { CheckResult } from "./types.js";

const MONITOR = "Secval (separate monitoring system)";
const DAY = 86_400_000;

export function liveResults(db: DB, hosts: string[], now: Date = new Date()): Record<string, CheckResult> {
  const out: Record<string, CheckResult> = {};
  for (const host of hosts) {
    // Uptime: at least 40 of the expected 48 half-hourly checks in the last 24 hours.
    const checks = listUptime(db, host, new Date(now.getTime() - DAY).toISOString());
    if (checks.length > 0 && !out["D19.1"]) {
      const ok = checks.filter((c) => c.ok).length;
      const last = checks[checks.length - 1]!.ts;
      out["D19.1"] =
        checks.length >= 40
          ? {
              status: "verified",
              level: "production",
              evidence: [{ link: `secval uptime_checks host=${host} (last 24 h)`, kind: "telemetry", date: last, environment: "production", reviewer: MONITOR }],
              note: `${checks.length} checks in 24 h, ${ok} answered OK (${Math.round((100 * ok) / checks.length)}%)`,
            }
          : { status: "unknown", evidence: [], note: `only ${checks.length} of 48 expected checks in 24 h (monitor was asleep or new)` };
    }

    // Passive scan: newest completed scan, any high finding fails the check.
    const scan = db
      .prepare(`SELECT id, finished_at FROM scans WHERE target = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`)
      .get(host) as { id: string; finished_at: string } | undefined;
    if (scan && !out["D10.1"]) {
      const high = (db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE scan_id = ? AND severity = 'high'`).get(scan.id) as { n: number }).n;
      out["D10.1"] = {
        status: high === 0 ? "verified" : "failed",
        level: "production",
        evidence: [{ link: `secval scan ${scan.id} (${host})`, kind: "measurement", date: scan.finished_at, environment: "production", reviewer: MONITOR }],
        note: high === 0 ? "no high findings" : `${high} high finding(s)`,
      };
    }

    // CI on the deploy branch (filled by the CI watch every 15 minutes).
    const ci = getCiSignal(host);
    if (ci && !out["D27.3"] && (ci.failing.length || ci.latest)) {
      const failing = ci.failing.length > 0;
      out["D27.3"] = {
        status: failing ? "failed" : ci.latest?.conclusion === "success" ? "verified" : "unknown",
        level: "prodlike",
        evidence: [{ link: failing ? ci.failing[0]!.url : ci.latest!.url, kind: "ci-run", date: ci.checkedAt, environment: "test", reviewer: MONITOR }],
        note: failing ? `failing: ${ci.failing.map((f) => f.name).join(", ")}` : `latest: ${ci.latest?.name} ${ci.latest?.conclusion}`,
      };
    }

    if (host === SELF_HOST) {
      const b = backupStatus(db, now);
      if (b.lastDrill) {
        out["D23.1"] = {
          status: b.healthy ? "verified" : "failed",
          level: "production",
          evidence: [{ link: "secval /api/backup (daily restore drill)", kind: "drill", date: b.lastDrill.at, environment: "production", reviewer: MONITOR }],
          note: b.healthy ? "backup on, last restore drill passed within 2 days" : `backup ${b.mode}; last drill ${b.lastDrill.ok ? "passed" : "failed"}`,
        };
      }
    }
  }
  return out;
}
