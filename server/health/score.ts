import type { DB } from "../db.js";
import { listAllowlist } from "../ownership/allowlist.js";
import { AREAS, listEstimates, type StoredEstimate } from "./report.js";
import { listUptime, type UptimeCheck } from "./uptime.js";

/**
 * A score backed by evidence. "measured" means secval checked it itself;
 * "estimate" means it came from a pasted report. A score is never invented:
 * when there is nothing to base it on, the area has no score at all.
 */
export interface Score {
  score: number;
  source: "measured" | "estimate";
  at: string;
  evidence: string[];
}

export interface AreaScores {
  key: string;
  label: string;
  measured: Score | null;
  estimate: Score | null;
}

export interface AppHealth {
  host: string;
  proven: boolean;
  overall: number | null;
  areas: AreaScores[];
  /** Pasted areas that do not fit the ten fixed ones. */
  other: StoredEstimate[];
  reports: number;
}

const DAY = 24 * 60 * 60_000;
const PENALTY = { high: 15, medium: 7, low: 3, info: 0 } as const;

/** Security, from the latest completed scan's findings. */
export function securityScore(db: DB, host: string): Score | null {
  const scan = db
    .prepare(
      `SELECT id, mode, finished_at FROM scans
       WHERE target = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(host) as { id: string; mode: string; finished_at: string } | undefined;
  if (!scan) return null;
  const findings = db
    .prepare(`SELECT severity, title FROM findings WHERE scan_id = ?`)
    .all(scan.id) as Array<{ severity: keyof typeof PENALTY; title: string }>;

  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  let penalty = 0;
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    penalty += PENALTY[f.severity] ?? 0;
  }
  const worst = findings
    .filter((f) => f.severity !== "info")
    .sort((a, b) => PENALTY[b.severity] - PENALTY[a.severity])
    .slice(0, 5)
    .map((f) => `${f.severity}: ${f.title}`);
  return {
    score: Math.max(0, 100 - penalty),
    source: "measured",
    at: scan.finished_at,
    evidence: [
      `Latest ${scan.mode} scan: ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`,
      `Start at 100, minus 15 per high, 7 per medium, 3 per low.`,
      ...worst,
    ],
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Reliability, from how often the home page answered over the last 7 days. */
export function reliabilityScore(checks7d: UptimeCheck[]): Score | null {
  if (!checks7d.length) return null;
  const ok = checks7d.filter((c) => c.ok).length;
  const last = checks7d[checks7d.length - 1]!;
  const uptime = (ok / checks7d.length) * 100;
  return {
    score: Math.round(uptime),
    source: "measured",
    at: last.ts,
    evidence: [
      `Home page answered ${ok} of ${checks7d.length} checks in the last 7 days (${uptime.toFixed(1)}%).`,
      last.ok
        ? `Last check: OK (status ${last.status}, ${last.ms} ms).`
        : `Last check: FAILED (${last.status ? "status " + last.status : last.error ?? "no answer"}).`,
      "Error handling inside the app is not checked yet.",
    ],
  };
}

/** Performance, from the typical answer time of the home page over 7 days. */
export function performanceScore(checks7d: UptimeCheck[]): Score | null {
  const times = checks7d.filter((c) => c.ok && c.ms !== null).map((c) => c.ms!);
  if (!times.length) return null;
  const med = median(times);
  const score = med <= 500 ? 100 : med <= 1000 ? 90 : med <= 1500 ? 80 : med <= 3000 ? 65 : 40;
  return {
    score,
    source: "measured",
    at: checks7d[checks7d.length - 1]!.ts,
    evidence: [
      `Typical home page answer time: ${med} ms over ${times.length} checks.`,
      "Up to 0.5 s = 100, 1 s = 90, 1.5 s = 80, 3 s = 65, slower = 40.",
      "A free host waking from sleep looks slow; that is counted. Load under many users is not tested.",
    ],
  };
}

/** Builds the whole dashboard: one entry per allowlisted app. */
export function dashboard(db: DB, now: Date = new Date()): AppHealth[] {
  const since7d = new Date(now.getTime() - 7 * DAY).toISOString();

  return listAllowlist(db).map((e) => {
    const checks7d = listUptime(db, e.domain, since7d);
    const measured: Record<string, Score | null> = {
      security: securityScore(db, e.domain),
      reliability: reliabilityScore(checks7d),
      performance: performanceScore(checks7d),
    };

    const estimates = listEstimates(db, e.domain);
    const latestEstimate = (key: string): Score | null => {
      const newest = estimates.find((s) => s.area === key);
      if (!newest) return null;
      return {
        score: newest.score,
        source: "estimate",
        at: newest.createdAt,
        evidence: [`From a pasted report (${newest.label}).`, newest.evidence].filter(Boolean),
      };
    };

    const areas = AREAS.map((a) => ({
      key: a.key,
      label: a.label,
      measured: measured[a.key] ?? null,
      estimate: latestEstimate(a.key),
    }));
    // Overall: average of each area's best-known score (measured wins).
    const best = areas
      .map((a) => (a.measured ?? a.estimate)?.score)
      .filter((s): s is number => typeof s === "number");
    const newestReport = estimates[0]?.createdAt;
    return {
      host: e.domain,
      proven: e.ownershipProven,
      overall: best.length ? Math.round(best.reduce((a, b) => a + b, 0) / best.length) : null,
      areas,
      other: estimates.filter((s) => s.area === "other" && s.createdAt === newestReport),
      reports: new Set(estimates.map((s) => s.createdAt)).size,
    };
  });
}
