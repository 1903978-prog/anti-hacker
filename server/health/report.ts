import type { DB } from "../db.js";
import { toHostname } from "../util/host.js";
import { listAllowlist } from "../ownership/allowlist.js";
import { appendAudit } from "../audit/log.js";

/**
 * Apps shown on the dashboard that are not on the scan allowlist (so they
 * are never scanned or checked, only rated from reports). secval itself is
 * here so it can rate itself without becoming a scan target.
 */
export const REPORT_ONLY_APPS = ["secval.onrender.com"] as const;

/** Every app the dashboard shows: the allowlist plus report-only apps. */
export function dashboardHosts(db: DB): Array<{ host: string; proven: boolean }> {
  const list = listAllowlist(db).map((e) => ({ host: e.domain, proven: e.ownershipProven }));
  for (const host of REPORT_ONLY_APPS) {
    if (!list.some((e) => e.host === host)) list.push({ host, proven: false });
  }
  return list;
}

/** The dashboard's fixed areas (Livio's 10 criteria), in display order. */
export const AREAS = [
  { key: "security", label: "Security & Access Control" },
  { key: "secrets", label: "Secrets in Code (passwords & keys)" },
  { key: "privacy", label: "Data Protection & Privacy" },
  { key: "integrity", label: "Data Integrity & Consistency" },
  { key: "persistence", label: "Data Persistence & Recovery" },
  { key: "database", label: "Database Design & Structure" },
  { key: "ux", label: "User Experience & Interface" },
  { key: "performance", label: "Performance & Scalability" },
  { key: "reliability", label: "Reliability & Error Handling" },
  { key: "code", label: "Code Quality & Maintainability" },
  { key: "deploy", label: "Deployment & Operational Readiness" },
  { key: "seo", label: "SEO (Google & Bing search)" },
  { key: "geo", label: "GEO (AI assistants' answers)" },
] as const;

export type AreaKey = (typeof AREAS)[number]["key"];

/**
 * Areas rated only for some apps (Livio, 19/10/2026: SEO and GEO for the
 * public websites 10bonds and eendigo). Other apps show "-" and these areas
 * never count in their overall score.
 */
export const SCOPED_AREAS: Partial<Record<AreaKey, readonly string[]>> = {
  seo: ["10bonds", "eendigo"],
  geo: ["10bonds", "eendigo"],
  // Livio, 20/10/2026: rated from each app's code repository; eendigo has none.
  secrets: ["compplan", "lm-op-model", "nexus-eendigo", "10bonds", "secval"],
};

/** Whether an area is rated for this app (matched on the first part of its address). */
export function appliesTo(area: string, host: string): boolean {
  const only = SCOPED_AREAS[area as AreaKey];
  if (!only) return true;
  const name = host.replace(/^www\./, "").split(".")[0]!;
  return only.includes(name);
}

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
  // GEO first: its names mention access and search, which other areas use too.
  if (/\bgeo\b|generative engine|ai (search|visibility|assistant|answer)/.test(n)) return "geo";
  if (/\bseo\b|search engine/.test(n)) return "seo";
  if (/secret|password|credential|api key/.test(n)) return "secrets";
  // Only a rated database line ("Database Design: 70"); a plain "Database:" is an infra fact.
  if (/database (design|quality|structure|practice)|data model|schema design/.test(n)) return "database";
  if (/privacy|protection/.test(n)) return "privacy";
  if (/secur|access|auth/.test(n)) return "security";
  if (/persist|recover|backup/.test(n)) return "persistence";
  if (/integrit|consisten/.test(n)) return "integrity";
  if (/user exp|interface|\bux\b|\bui\b|usabil/.test(n)) return "ux";
  if (/perform|scal|speed/.test(n)) return "performance";
  if (/reliab|error|solid|stabil|robust|uptime/.test(n)) return "reliability";
  if (/code|maintain/.test(n)) return "code";
  if (/deploy|operat|\bops\b/.test(n)) return "deploy";
  if (/\bdata\b/.test(n)) return "integrity";
  return "other";
}

/** Infrastructure facts a report can carry (text, not scores). */
export const INFRA = [
  { key: "hosting", label: "Hosted on" },
  { key: "deploy", label: "Deploys via" },
  { key: "shipper", label: "Who ships it" },
  { key: "db", label: "Database" },
  { key: "repo", label: "Code repository" },
  { key: "usage", label: "Resource use (last week)" },
] as const;

export type InfraKey = (typeof INFRA)[number]["key"];

export interface ParsedInfra {
  key: InfraKey;
  label: string;
  value: string;
}

/** Maps a report's line name to an infrastructure fact, if it is one. */
export function classifyInfra(name: string): InfraKey | null {
  const n = name.toLowerCase();
  if (n.split(/\s+/).length > 5) return null;
  if (/usage|resource|minutes|bandwidth|memory|\bcpu\b|\bcost|quota/.test(n)) return "usage";
  if (/\bdb\b|database/.test(n)) return "db";
  if (/\brepo/.test(n)) return "repo";
  if (/ship/.test(n)) return "shipper";
  if (/deploy/.test(n)) return "deploy";
  if (/\bhost(ing|ed)?\b|platform|provider/.test(n)) return "hosting";
  return null;
}

/**
 * Reads infrastructure facts ("Database: Neon Postgres", "| DB name | ... |").
 * A line whose name is also a scored area (e.g. "Deployment & Operational
 * Readiness: 88") is a score, not a fact, when its value starts with a number.
 */
export function parseInfra(text: string): ParsedInfra[] {
  const out: ParsedInfra[] = [];
  let prevWasTable = false;
  let factTable = false;
  for (const raw of text.slice(0, MAX_REPORT_CHARS).split(/\r?\n/)) {
    const line = raw.trim();
    let name: string | undefined;
    let value: string | undefined;
    const isTable = line.startsWith("|");
    // Only small tables without a score column hold facts ("| DB name | x |").
    if (isTable && !prevWasTable) {
      prevWasTable = true;
      const cols = rowCells(line).length;
      factTable = !/score|rating/i.test(line) && cols <= 3;
      if (!factTable || cols < 2) continue;
    }
    prevWasTable = isTable;
    if (isTable) {
      if (!factTable) continue;
      const cells = rowCells(line);
      if (cells.length < 2 || /^:?-+:?$/.test(cells[0] ?? "")) continue;
      name = cells[0];
      value = cells.slice(1).filter(Boolean).join(" · ");
    } else {
      const m = /^[-*\s]*([^:]{2,40}):\s*(.+)$/.exec(clean(line));
      if (!m) continue;
      [, name, value] = m;
    }
    if (!name || !value) continue;
    const key = classifyInfra(name);
    if (!key) continue;
    const isArea = classifyArea(name) !== "other";
    if (isArea && /^~?\s*\d{1,3}(?!\d)/.test(value)) continue;
    // One fact per key, except usage, which may list several services.
    if (key !== "usage" && out.some((f) => f.key === key)) continue;
    out.push({ key, label: clean(name), value: value.slice(0, 300) });
  }
  return out;
}

const clean = (s: string) => s.replace(/\*\*|__|`/g, "").trim();

/** A table row's cells, without a leading row-number column ("| 1 | ..." or "| # | ..."). */
function rowCells(line: string): string[] {
  const cells = line.replace(/^\||\|$/g, "").split("|").map(clean);
  return /^(#|\d{1,2}\.?)$/.test(cells[0] ?? "") ? cells.slice(1) : cells;
}

/**
 * Reads scores out of a pasted report. Understands markdown tables
 * ("| Area | Score | Why |") and simple lines ("Security: ~82 - why").
 * Scores must be 0-100; anything else is ignored rather than guessed.
 */
export function parseReport(text: string): ParsedScore[] {
  const out: ParsedScore[] = [];
  const seen = new Set<string>();
  let prevWasTable = false;
  let scoreTable = false;
  for (const raw of text.slice(0, MAX_REPORT_CHARS).split(/\r?\n/)) {
    const line = raw.trim();
    let name: string | undefined;
    let scoreText: string | undefined;
    let why = "";

    const isTable = line.startsWith("|");
    // A table's first row is its header; only tables with a "Score" column hold scores.
    if (isTable && !prevWasTable) {
      prevWasTable = true;
      scoreTable = /score|rating/i.test(line);
      continue;
    }
    prevWasTable = isTable;

    if (isTable) {
      if (!scoreTable) continue;
      const cells = rowCells(line);
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

    // The score cell must start with the number ("~82", "82%", "82/100").
    const num = /^~?\s*(\d{1,3})(?![\d.,])/.exec(scoreText ?? "");
    if (!name || !num) continue;
    // Infra facts like "Usage: 1,200 minutes" are not scores.
    if (classifyInfra(name) && classifyArea(name) === "other") continue;
    const score = Number(num[1]);
    if (score < 0 || score > 100) continue;
    const area = classifyArea(name);
    // The first score for an area wins; later mentions are commentary.
    if (area !== "other" && seen.has(area)) continue;
    seen.add(area);
    out.push({ area, label: clean(name), score, evidence: clean(why) });
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
  for (const e of dashboardHosts(db).map((h) => ({ domain: h.host }))) {
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
  infra: ParsedInfra[];
}

/** Saves a pasted report and its scores. Returns null if nothing could be read. */
export function saveReport(
  db: DB,
  appTarget: string,
  text: string,
  actor: string,
): SavedReport | { error: string } {
  const host = toHostname(appTarget);
  if (!host || !dashboardHosts(db).some((e) => e.host === host)) {
    return { error: "pick an app from your allowlist" };
  }
  const scores = parseReport(text);
  const infra = parseInfra(text);
  if (!scores.length && !infra.length) return { error: "no scores or infrastructure facts found in that text" };

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
    const insInfra = db.prepare(
      `INSERT INTO health_infra (report_id, host, key, label, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const f of infra) insInfra.run(reportId, host, f.key, f.label, f.value, now);
    return reportId;
  });
  const reportId = tx();
  appendAudit(db, {
    actor,
    action: "health.report",
    target: host,
    decision: "info",
    detail: { reportId, scores: scores.length, infra: infra.length },
  });
  return { reportId, host, scores, infra };
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

export interface StoredInfra {
  key: string;
  label: string;
  value: string;
  createdAt: string;
}

/** Every pasted infrastructure fact for a host, newest first. */
export function listInfra(db: DB, host: string): StoredInfra[] {
  const rows = db
    .prepare(`SELECT * FROM health_infra WHERE host = ? ORDER BY created_at DESC, id`)
    .all(host) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    key: r.key as string,
    label: r.label as string,
    value: r.value as string,
    createdAt: r.created_at as string,
  }));
}

/**
 * Names who builds and ships an app, from any text about how it deploys:
 * GitHub Actions (spends Actions minutes), Fly, or Render. Null if unclear.
 */
export function shipperFrom(text: string): string | null {
  const t = text.toLowerCase();
  // The service named first is the one doing the shipping; a workflow file
  // (e.g. "fly-deploy.yml") means GitHub Actions, even if it names Fly.
  const candidates: Array<[RegExp, string]> = [
    [/github actions|workflow|[\w-]+\.ya?ml\b|\bgha\b/, "GitHub Actions (uses GitHub minutes)"],
    [/\bfly\b|fly\.io|flyctl/, "Fly (builds on Fly)"],
    [/render/, "Render (builds on Render)"],
  ];
  let best: { at: number; who: string } | null = null;
  for (const [re, who] of candidates) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { at: m.index, who };
  }
  return best?.who ?? null;
}
