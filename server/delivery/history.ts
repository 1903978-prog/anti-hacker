/**
 * Open atoms over time (16 Nov 2026, Livio: "chart with nb of atoms open over
 * time, last 72h"). The ledger file keeps no history of its own, so the history
 * is rebuilt from the git commits that changed docs/delivery-ledger.json on the
 * branch the page reads it from: one point per commit = open atoms in that
 * version of the file. Nothing is interpolated or invented.
 *
 * READ-ONLY: GET requests to the GitHub API only. Each commit's file is read
 * once and kept (a commit never changes).
 */
import { LEDGER_PATH, OWNER, parseLedger, type GhFetcher } from "./ledger.js";

export const WINDOW_HOURS = 72;
/** At most this many file versions are read per refresh; the newest win. */
export const MAX_POINTS = 40;

export interface HistoryPoint {
  at: string;
  open: number;
  total: number;
  sha: string;
}

export interface HistoryView {
  repo: string;
  branch: string | null;
  from: string;
  to: string;
  points: HistoryPoint[];
  /** Plain words shown under the chart: where the points come from and what is missing. */
  note: string;
}

interface Commit {
  sha?: string;
  commit?: { committer?: { date?: string }; author?: { date?: string } };
}

const byShaCache = new Map<string, { open: number; total: number } | null>();

export function clearHistoryCache(): void {
  byShaCache.clear();
}

function headers(token: string | undefined, raw: boolean): Record<string, string> {
  return {
    accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "secval",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function listCommits(url: string, token: string | undefined, f: GhFetcher): Promise<Commit[] | null> {
  const res = await f(url, { method: "GET", headers: headers(token, false) });
  if (res.status !== 200) return null;
  const body = JSON.parse(await res.text()) as unknown;
  return Array.isArray(body) ? (body as Commit[]) : null;
}

async function countsAt(repo: string, sha: string, token: string | undefined, f: GhFetcher) {
  const key = `${repo}@${sha}`;
  if (byShaCache.has(key)) return byShaCache.get(key)!;
  const res = await f(
    `https://api.github.com/repos/${OWNER}/${encodeURIComponent(repo)}/contents/${LEDGER_PATH}?ref=${encodeURIComponent(sha)}`,
    { method: "GET", headers: headers(token, true) },
  );
  let out: { open: number; total: number } | null = null;
  if (res.status === 200) {
    const app = parseLedger(repo, await res.text());
    if (app.status === "ok") out = { open: app.counts.open, total: app.counts.total };
  }
  // Only a definite answer is kept; a GitHub hiccup is retried next time.
  if (res.status === 200 || res.status === 404) byShaCache.set(key, out);
  return out;
}

const when = (c: Commit) => c.commit?.committer?.date || c.commit?.author?.date || "";

/** Open atoms after each change of the ledger file in the last 72 hours, plus the version in force when the window opened. */
export async function loadHistory(
  repo: string,
  branch: string | null | undefined,
  token: string | undefined,
  f: GhFetcher,
  now: number = Date.now(),
): Promise<HistoryView> {
  const to = new Date(now).toISOString();
  const from = new Date(now - WINDOW_HOURS * 3_600_000).toISOString();
  const base: HistoryView = { repo, branch: branch ?? null, from, to, points: [], note: "" };
  if (!branch) return { ...base, note: "No ledger file found, so there is no history to show." };
  const api = `https://api.github.com/repos/${OWNER}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(LEDGER_PATH)}&sha=${encodeURIComponent(branch)}`;
  try {
    const inWindow = await listCommits(`${api}&since=${encodeURIComponent(from)}&per_page=100`, token, f);
    if (!inWindow) return { ...base, note: "GitHub did not return the file's history." };
    const before = (await listCommits(`${api}&until=${encodeURIComponent(from)}&per_page=1`, token, f)) ?? [];
    let commits = inWindow.filter((c) => c.sha && when(c));
    const skipped = Math.max(0, commits.length - MAX_POINTS);
    commits = commits.slice(0, MAX_POINTS); // GitHub lists newest first
    const all = [...commits, ...before.filter((c) => c.sha && when(c)).slice(0, 1)];
    const points: HistoryPoint[] = [];
    let unreadable = 0;
    for (const c of all) {
      const n = await countsAt(repo, c.sha!, token, f);
      if (!n) {
        unreadable++;
        continue;
      }
      // The version in force when the window opened is drawn at the window's start.
      const at = Date.parse(when(c)) < Date.parse(from) ? from : when(c);
      points.push({ at, open: n.open, total: n.total, sha: c.sha!.slice(0, 8) });
    }
    points.sort((a, b) => a.at.localeCompare(b.at));
    const parts = [`${commits.length} change(s) of the ledger file on branch ${branch} in the last ${WINDOW_HOURS} hours.`];
    if (before.length && points.some((p) => p.at === from)) parts.push("The first point is the version in force 72 hours ago.");
    else parts.push("No older version exists, so the line starts at the file's first commit.");
    if (skipped) parts.push(`Only the newest ${MAX_POINTS} changes are shown (${skipped} older ones in the window left out).`);
    if (unreadable) parts.push(`${unreadable} version(s) could not be read and are left out.`);
    return { ...base, points, note: parts.join(" ") };
  } catch {
    return { ...base, note: "GitHub could not be reached, so the history is not shown." };
  }
}

const realFetch: GhFetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
const viewCache = new Map<string, { at: number; view: HistoryView }>();

export function clearHistoryViews(): void {
  viewCache.clear();
}

/** Cached for 10 minutes per repo and branch (the same pace as the page). */
export async function getHistory(
  repo: string,
  branch: string | null | undefined,
  token: string | undefined,
  f: GhFetcher = realFetch,
  now: number = Date.now(),
): Promise<HistoryView> {
  const key = `${repo}@${branch ?? ""}`;
  const hit = viewCache.get(key);
  if (hit && now - hit.at < 10 * 60_000) return hit.view;
  const view = await loadHistory(repo, branch, token, f, now);
  viewCache.set(key, { at: now, view });
  return view;
}
