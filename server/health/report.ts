import type { DB } from "../db.js";
import { toHostname } from "../util/host.js";
import { listAllowlist } from "../ownership/allowlist.js";
import { appendAudit } from "../audit/log.js";

/** The dashboard's fixed areas (Livio's 10 criteria), in display order. */
export const AREAS = [
  { key: "security", label: "Security & Access Control" },
  { key: "privacy", label: "Data Protection & Privacy" },
  { key: "integrity", label: "Data Integrity & Consistency" },
  { key: "persistence", label: "Data Persistence & Recovery" },
  { key: "functional", label: "Functional Completeness" },
  { key: "ux", label: "User Experience & Interface" },
  { key: "performance", label: "Performance & Scalability" },
  { key: "reliability", label: "Reliability & Error Handling" },
  { key: "code", label: "Code Quality & Maintainability" },
  { key: "deploy", label: "Deployment & Operational Readiness" },
] as const;

export type AreaKey = (typeof AREAS)[number]["key"];

export interface ParsedScore {
  /** One of AREAS' keys, or "other" when the area name is not recognised. */
  area: AreaKey | "other";
  /** The area name as written in the report. */
  label: string;
  score: number;
  evidence: string;
}

const MAX_REPORT_CHARS = 20_000;

/** Maps a report's area name to a dashboard area. Specific words win over "data". */
export function classifyArea(name: string): AreaKey | "other" {
  const n = name.toLowerCase();
  if (/privacy|protection/.test(n)) return "privacy";
  if (/secur|access|auth/.test(n)) return "security";
  if (/persist|recover|backup/.test(n)) return "persistence";
  if (/integrit|consisten/.test(n)) return "integrity";
  if (/function|feature|complete/.test(n)) return "functional";
  if (/user exp|interface|\bux\b|\bui\b|usabil/.test(n)) return "ux";
  if (/perform|scal|speed/.test(n)) return "performance";
  if (/reliab|error|solid|stabil|robust|uptime/.test(n)) return "reliability";
  if (/code|maintain/.test(n)) return "code";
  if (/deploy|operat|\bops\b/.test(n)) return "deploy";
  if (/\bdata\b/.test(n)) return "integrity";
  return "other";
}

const clean = (s: string) => s.replace(/\*\*|__|`/g, "").trim();

/**
 * Reads scores out of a pasted report. Understands markdown tables
 * ("| Area | Score | Why |") and simple lines ("Security: ~82 - why").
 * Scores must be 0-100; anything else is ignored rather than guessed.
 */
export function parseReport(text: string): ParsedScore[] {
  const out: ParsedScore[] = [];
  for (const raw of text.slice(0, MAX_REPORT_CHARS).split(/\r?\n/)) {
    const line = raw.trim();
    let name: string | undefined;
    let scoreText: string | undefined;
    let why = "";

    if (line.startsWith("|")) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map(clean);
      if (cells.length < 2 || /^:?-+:?$/.test(cells[0] ?? "")) continue;
      [name, scoreText] = cells;
      why = cells.slice(2).join(" ");
    } else {
      const m = /^[-*\s]*([A-Za-z][A-Za-z /&-]{2,40}?)\s*[:=]\s*~?\s*(\d{1,3})\b\s*(?:\/\s*100)?\s*[-–—:,.]?\s*(.*)$/.exec(
        clean(line),
      );
      if (!m) continue;
      [, name, scoreText, why = ""] = m;
    }

    const num = /~?\s*(\d{1,3})(?!\d)/.exec(scoreText ?? "");
    if (!name || !num) continue;
    const score = Number(num[1]);
    if (score < 0 || score > 100) continue;
    out.push({ area: classifyArea(name), label: clean(name), score, evidence: clean(why) });
  }
  return out;
}

/**
 * Guesses which app a report is about by counting mentions of each
 * allowlisted app's short name (e.g. "compplan" for compplan.onrender.com).
 */
export function guessApp(db: DB, text: string): string | null {
  const lower = text.toLowerCase();
  let best: { host: string; count: number } | null = null;
  for (const e of listAllowlist(db)) {
    const full = e.domain.split(".")[0]!;
    const short = full.split("-")[0]!;
    // A very short prefix (e.g. "lm") would match ordinary words.
    const names = short.length >= 4 && short !== full ? [full, short] : [full];
    const count = names.reduce((n, name) => n + (lower.split(name).length - 1), 0);
    if (count > 0 && (!best || count > best.count)) best = { host: e.domain, count };
  }
  return best?.host ?? null;
}

export interface SavedReport {
  reportId: number;
  host: string;
  scores: ParsedScore[];
}

/** Saves a pasted report and its scores. Returns null if nothing could be read. */
export function saveReport(
  db: DB,
  appTarget: string,
  text: string,
  actor: string,
): SavedReport | { error: string } {
  const host = toHostname(appTarget);
  if (!host || !listAllowlist(db).some((e) => e.domain === host)) {
    return { error: "pick an app from your allowlist" };
  }
  const scores = parseReport(text);
  if (!scores.length) return { error: "no scores found in that text" };

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO health_reports (host, created_at, text) VALUES (?, ?, ?)`)
      .run(host, now, text.slice(0, MAX_REPORT_CHARS));
    const reportId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO health_scores (report_id, host, area, label, score, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of scores) ins.run(reportId, host, s.area, s.label, s.score, s.evidence, now);
    return reportId;
  });
  const reportId = tx();
  appendAudit(db, {
    actor,
    action: "health.report",
    target: host,
    decision: "info",
    detail: { reportId, scores: scores.length },
  });
  return { reportId, host, scores };
}

export interface StoredEstimate {
  area: string;
  label: string;
  score: number;
  evidence: string;
  createdAt: string;
}

/** Every pasted score for a host, newest first. */
export function listEstimates(db: DB, host: string): StoredEstimate[] {
  const rows = db
    .prepare(`SELECT * FROM health_scores WHERE host = ? ORDER BY created_at DESC, id`)
    .all(host) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    area: r.area as string,
    label: r.label as string,
    score: Number(r.score),
    evidence: r.evidence as string,
    createdAt: r.created_at as string,
  }));
}
