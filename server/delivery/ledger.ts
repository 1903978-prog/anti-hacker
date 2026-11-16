/**
 * Delivery ledger (16 Nov 2026, Livio): shows each app's docs/delivery-ledger.json
 * (written by the /een-code skill) as one table per app.
 *
 * READ-ONLY: this module only sends GET requests to the GitHub API. It never
 * writes to any repository. The token comes from GITHUB_LEDGER_TOKEN, falling
 * back to the read-only GITHUB_USAGE_TOKEN already in the Render env group.
 * The token is never logged, returned or shown.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const OWNER = "1903978-prog";
export const LEDGER_PATH = "docs/delivery-ledger.json";
/** Apps always listed, even before their ledger file exists. */
export const KNOWN_REPOS = ["compplan", "lm-op-model", "nexus-eendigo", "10bonds"];
export const REFRESH_MS = 10 * 60_000;
/** A forced refresh (button) runs at most this often, so clicks cannot flood GitHub. */
const MIN_FORCED_GAP_MS = 30_000;

export type Stage = "yes" | "no" | "parked" | "unknown";
export const STAGES = ["implemented", "tested", "merged", "deployed", "live_checked"] as const;
export type StageKey = (typeof STAGES)[number];

export interface Atom {
  id: string;
  parent: string;
  asked_at: string;
  asked_time: string;
  original_ask: string;
  atom: string;
  implemented: Stage;
  tested: Stage;
  merged: Stage;
  deployed: Stage;
  live_checked: Stage;
  next_step: string;
  evidence: string;
  updated_at: string;
  done: boolean;
  /** Optional ledger fields (16 Nov 2026 progress view). Empty string = not recorded. */
  owner: string;
  branch: string;
  pr: string;
  head_sha: string;
  tested_sha: string;
  /** Pull request housekeeping, shown as written; never inferred from the other stages. */
  pr_housekeeping: string;
  /** "code" (default) or "non-code" (a document, decision or other deliverable). */
  kind: "code" | "non-code";
  in_progress: Stage;
  deliverable_confirmed: Stage;
  /** Tests were recorded on a different SHA than the current head, so they do not count. */
  tested_stale: boolean;
  /** 0, 20, 40, 55, 70, 85 or 100, computed from the stages (never typed in). */
  percent: number;
  stage_label: string;
}

/** One requested action (a parent) with its atoms' average progress. */
export interface Action {
  code: string;
  description: string;
  asked_at: string;
  asked_time: string;
  owner: string;
  branch: string;
  pr: string;
  head_sha: string;
  pr_housekeeping: string;
  atom_ids: string[];
  atoms_done: number;
  percent: number;
  stage_label: string;
  /** The atom furthest behind, or null when every atom is at 100%. */
  next: { id: string; atom: string; next_step: string; stage_label: string } | null;
  done: boolean;
}

export interface AppLedger {
  repo: string;
  project: string;
  /** ok = file read; missing = repo has no ledger file yet; no-access = token cannot read it; error = bad file or GitHub failure. */
  status: "ok" | "missing" | "no-access" | "error";
  message?: string;
  lastSynced?: string;
  link: string;
  /** Branch the ledger file was read from (integration, default branch or an open PR branch). */
  branch?: string;
  /** Pasted starting point, shown only while the live ledger file cannot be read. */
  snapshot?: Snapshot;
  /** Open pull requests in the repo right now (null = could not be read). */
  openPrs: number | null;
  prsLink: string;
  atoms: Atom[];
  actions: Action[];
  counts: { total: number; done: number; open: number } & Record<StageKey, number>;
}

const SnapshotIn = z.object({
  repo: z.string(),
  label: z.string(),
  source: z.string().default(""),
  headline: z.string().default(""),
  /** Secval's own note on the pasted text (never a correction of it). */
  check: z.string().default(""),
  groups: z.array(z.object({ group: z.string(), atoms: z.string(), stages: z.string(), next_step: z.string() })),
  counts: z.string().default(""),
  blockers: z.array(z.string()).default([]),
  footer: z.string().default(""),
});
export type Snapshot = z.infer<typeof SnapshotIn>;

export const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "reports", "delivery-snapshots");

/** A pasted registry summary kept in reports/delivery-snapshots/<repo>.json, as written; null when none or broken. */
export function loadSnapshot(repo: string, dir = SNAPSHOT_DIR): Snapshot | null {
  const file = join(dir, `${repo.replace(/[^a-z0-9._-]/gi, "")}.json`);
  if (!existsSync(file)) return null;
  try {
    const r = SnapshotIn.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return r.success && r.data.repo === repo ? r.data : null;
  } catch {
    return null;
  }
}

export interface DeliveryView {
  checkedAt: string | null;
  tokenSet: boolean;
  apps: AppLedger[];
}

export type GhFetcher = (
  url: string,
  init: { method: "GET"; headers: Record<string, string> },
) => Promise<{ status: number; text: () => Promise<string> }>;

const realFetch: GhFetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

/** "yes", "✅", true, "done", "passed" → yes; "no", "❌", false → no; "parked", "⏸" → parked; anything else → unknown. */
export function normStage(v: unknown): Stage {
  if (v === true) return "yes";
  if (v === false) return "no";
  const s = String(v ?? "").trim().toLowerCase();
  if (["yes", "✅", "done", "passed", "pass", "true", "y"].includes(s)) return "yes";
  if (["no", "❌", "not done", "not started", "failed", "fail", "false", "n"].includes(s)) return "no";
  if (["parked", "⏸", "⏸️", "superseded", "withdrawn"].includes(s)) return "parked";
  return "unknown";
}

const text = z.preprocess((v) => (v == null ? "" : typeof v === "string" ? v : String(v)), z.string());
const AtomIn = z.object({
  id: text,
  parent: text.optional(),
  asked_at: text.optional(),
  asked_time: text.optional(),
  original_ask: text.optional(),
  atom: text.optional(),
  implemented: z.unknown().optional(),
  tested: z.unknown().optional(),
  merged: z.unknown().optional(),
  deployed: z.unknown().optional(),
  live_checked: z.unknown().optional(),
  next_step: text.optional(),
  evidence: text.optional(),
  updated_at: text.optional(),
  owner: text.optional(),
  branch: text.optional(),
  pr: text.optional(),
  head_sha: text.optional(),
  tested_sha: text.optional(),
  pr_housekeeping: text.optional(),
  kind: text.optional(),
  in_progress: z.unknown().optional(),
  deliverable_confirmed: z.unknown().optional(),
});
const LedgerIn = z.object({
  project: text.optional(),
  repo: text.optional(),
  last_synced: text.optional(),
  atoms: z.array(z.unknown()),
});

/** Progress points per stage (Livio, 16 Nov 2026). */
export const PROGRESS = [
  { pct: 0, label: "Requested, not started" },
  { pct: 20, label: "Work in progress" },
  { pct: 40, label: "Built on a branch" },
  { pct: 55, label: "Tests passed on the current version" },
  { pct: 70, label: "Merged" },
  { pct: 85, label: "Deployed, not yet checked live" },
  { pct: 100, label: "Verified live" },
] as const;
const NON_CODE_DONE = "Deliverable confirmed complete";

export function labelFor(pct: number, kind: "code" | "non-code" = "code"): string {
  if (kind === "non-code" && pct === 100) return NON_CODE_DONE;
  return PROGRESS.find((p) => p.pct === pct)?.label ?? `${pct}%`;
}

/** True when both SHAs are known and neither is a prefix of the other. */
export function shaDiffers(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return !(x.startsWith(y) || y.startsWith(x));
}

type ProgressIn = Pick<Atom, StageKey | "kind" | "in_progress" | "deliverable_confirmed" | "head_sha" | "tested_sha">;

/**
 * One atom's progress. Stages count only in order and only when "yes": a later
 * stage marked done does not lift the bar past an earlier stage that is not
 * done or unknown (each stage still shows on its own in the table). Tests count
 * only when they ran on the current head SHA (or no SHA was recorded for either).
 */
export function atomProgress(a: ProgressIn): { percent: number; tested_stale: boolean } {
  const tested_stale = a.tested === "yes" && shaDiffers(a.tested_sha, a.head_sha);
  const start = a.in_progress === "yes" ? 20 : 0;
  if (a.kind === "non-code") return { percent: a.deliverable_confirmed === "yes" ? 100 : start, tested_stale: false };
  const chain: [boolean, number][] = [
    [a.implemented === "yes", 40],
    [a.tested === "yes" && !tested_stale, 55],
    [a.merged === "yes", 70],
    [a.deployed === "yes", 85],
    [a.live_checked === "yes", 100],
  ];
  let percent = start;
  for (const [ok, pct] of chain) {
    if (!ok) break;
    percent = pct;
  }
  return { percent, tested_stale };
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Groups atoms by parent; an action's percent is the plain average of its atoms. */
export function buildActions(atoms: Atom[]): Action[] {
  const groups = new Map<string, Atom[]>();
  for (const a of atoms) {
    const key = a.parent || a.id;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const out: Action[] = [];
  for (const [code, list] of groups) {
    const done = list.every((a) => a.percent === 100);
    const avg = list.reduce((n, a) => n + a.percent, 0) / list.length;
    // Never show 100% (by rounding) while any atom is unfinished.
    const percent = done ? 100 : Math.min(99, Math.round(avg));
    const lowest = list.reduce((m, a) => (a.percent < m.percent ? a : m), list[0]!);
    // Next action = the requirement furthest behind (first one on a tie).
    const first = done ? undefined : lowest;
    const join = (k: "owner" | "branch" | "pr" | "head_sha" | "pr_housekeeping") => uniq(list.map((a) => a[k])).join(", ");
    out.push({
      code,
      description: list[0]!.original_ask || list[0]!.atom,
      asked_at: list[0]!.asked_at,
      asked_time: list[0]!.asked_time,
      owner: join("owner"),
      branch: join("branch"),
      pr: join("pr"),
      head_sha: join("head_sha"),
      pr_housekeeping: join("pr_housekeeping"),
      atom_ids: list.map((a) => a.id),
      atoms_done: list.filter((a) => a.percent === 100).length,
      percent,
      stage_label: done ? lowest.stage_label : list.length === 1 ? lowest.stage_label : `Furthest behind: ${lowest.stage_label}`,
      next: first ? { id: first.id, atom: first.atom, next_step: first.next_step, stage_label: first.stage_label } : null,
      done,
    });
  }
  return out;
}

function emptyCounts(): AppLedger["counts"] {
  return { total: 0, done: 0, open: 0, implemented: 0, tested: 0, merged: 0, deployed: 0, live_checked: 0 };
}

/** Parses one ledger file. Bad rows are skipped and counted, never invented. */
export function parseLedger(repo: string, raw: string): AppLedger {
  const base = baseApp(repo);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...base, status: "error", message: "The ledger file is not valid JSON." };
  }
  const parsed = LedgerIn.safeParse(json);
  if (!parsed.success) return { ...base, status: "error", message: "The ledger file has no atoms list." };
  const atoms: Atom[] = [];
  let skipped = 0;
  for (const row of parsed.data.atoms) {
    const r = AtomIn.safeParse(row);
    if (!r.success || !r.data.id) {
      skipped++;
      continue;
    }
    const a = r.data;
    const stages = Object.fromEntries(STAGES.map((k) => [k, normStage(a[k])])) as Record<StageKey, Stage>;
    const kind = /^non[-_ ]?code$/i.test((a.kind ?? "").trim()) ? "non-code" : "code";
    const extra = {
      owner: a.owner ?? "",
      branch: a.branch ?? "",
      pr: a.pr ?? "",
      head_sha: a.head_sha ?? "",
      tested_sha: a.tested_sha ?? "",
      pr_housekeeping: a.pr_housekeeping ?? "",
      kind: kind as Atom["kind"],
      in_progress: normStage(a.in_progress),
      deliverable_confirmed: normStage(a.deliverable_confirmed),
    };
    const prog = atomProgress({ ...stages, ...extra });
    atoms.push({
      id: a.id,
      parent: a.parent ?? "",
      asked_at: a.asked_at ?? "",
      asked_time: a.asked_time ?? "",
      original_ask: a.original_ask ?? "",
      atom: a.atom ?? "",
      ...stages,
      next_step: a.next_step ?? "",
      evidence: a.evidence ?? "",
      updated_at: a.updated_at ?? "",
      done: prog.percent === 100,
      ...extra,
      tested_stale: prog.tested_stale,
      percent: prog.percent,
      stage_label: labelFor(prog.percent, kind),
    });
  }
  const counts = emptyCounts();
  for (const a of atoms) {
    counts.total++;
    if (a.done) counts.done++;
    for (const k of STAGES) if (a[k] === "yes") counts[k]++;
  }
  counts.open = counts.total - counts.done;
  return {
    ...base,
    project: parsed.data.project || repo,
    status: "ok",
    lastSynced: parsed.data.last_synced || undefined,
    atoms,
    actions: buildActions(atoms),
    counts,
    ...(skipped ? { message: `${skipped} row(s) without an atom ID were skipped.` } : {}),
  };
}

function baseApp(repo: string): AppLedger {
  return {
    repo,
    project: repo,
    status: "missing",
    link: `https://github.com/${OWNER}/${repo}/blob/HEAD/${LEDGER_PATH}`,
    openPrs: null,
    prsLink: `https://github.com/${OWNER}/${repo}/pulls`,
    atoms: [],
    actions: [],
    counts: emptyCounts(),
  };
}

function headers(token: string | undefined, raw: boolean): Record<string, string> {
  return {
    accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "secval",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** GitHub's own error text ("Not Found", "Bad credentials", ...), short and with nothing secret. */
async function ghError(res: { status: number; text: () => Promise<string> }): Promise<string> {
  try {
    const m = (JSON.parse(await res.text()) as { message?: unknown }).message;
    return typeof m === "string" ? `GitHub said ${res.status} "${m.slice(0, 120)}"` : `GitHub answered ${res.status}`;
  } catch {
    return `GitHub answered ${res.status}`;
  }
}

/** Branches to look in, in order: integration, the default branch, then open PR branches (max 50). */
async function candidateBranches(repo: string, defaultBranch: string, token: string | undefined, f: GhFetcher): Promise<string[]> {
  const out = ["integration", defaultBranch];
  try {
    const res = await f(`https://api.github.com/repos/${OWNER}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`, {
      method: "GET",
      headers: headers(token, false),
    });
    if (res.status === 200) {
      const prs = JSON.parse(await res.text()) as Array<{ head?: { ref?: string; repo?: { full_name?: string } | null } }>;
      for (const pr of prs) {
        const ref = pr.head?.ref;
        if (ref && pr.head?.repo?.full_name === `${OWNER}/${repo}`) out.push(ref);
      }
    }
  } catch {
    // Open PR branches are a bonus; integration and the default branch are still tried.
  }
  return [...new Set(out)].slice(0, 52);
}

/**
 * Reads one repo's ledger file (GET only): from integration first, then the
 * default branch, then any open PR branch that has it. Says which branch it came from.
 */
export async function fetchLedger(repo: string, token: string | undefined, f: GhFetcher): Promise<AppLedger> {
  const base = `https://api.github.com/repos/${OWNER}/${encodeURIComponent(repo)}`;
  try {
    const r = await f(base, { method: "GET", headers: headers(token, false) });
    if (r.status !== 200) {
      const why = await ghError(r);
      const hint =
        r.status === 404
          ? token
            ? "The GitHub token cannot read this repository"
            : "No GitHub token set, so this private repository cannot be read"
          : "GitHub refused the request";
      return { ...baseApp(repo), status: r.status === 404 || r.status === 401 || r.status === 403 ? "no-access" : "error", message: `${hint} (${why}).` };
    }
    const defaultBranch = String((JSON.parse(await r.text()) as { default_branch?: unknown }).default_branch || "main");
    let lastError = "";
    for (const branch of await candidateBranches(repo, defaultBranch, token, f)) {
      const res = await f(`${base}/contents/${LEDGER_PATH}?ref=${encodeURIComponent(branch)}`, { method: "GET", headers: headers(token, true) });
      if (res.status === 200) {
        const app = parseLedger(repo, await res.text());
        return { ...app, branch, link: `https://github.com/${OWNER}/${repo}/blob/${encodeURIComponent(branch)}/${LEDGER_PATH}` };
      }
      if (res.status !== 404) lastError = await ghError(res);
    }
    return {
      ...baseApp(repo),
      status: lastError ? "error" : "missing",
      message: lastError ? `The ledger file could not be read (${lastError}).` : "No ledger file on integration, the default branch or any open PR branch yet.",
    };
  } catch {
    return { ...baseApp(repo), status: "error", message: "GitHub could not be reached." };
  }
}

/** Number of open pull requests (GET search, one call); null when GitHub does not answer. */
export async function countOpenPrs(repo: string, token: string | undefined, f: GhFetcher): Promise<number | null> {
  const q = encodeURIComponent(`repo:${OWNER}/${repo} is:pr is:open`);
  try {
    const res = await f(`https://api.github.com/search/issues?q=${q}&per_page=1`, { method: "GET", headers: headers(token, false) });
    if (res.status !== 200) return null;
    const n = (JSON.parse(await res.text()) as { total_count?: unknown }).total_count;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Other repos of the owner that the token can see (GET only); used to find extra ledger files. */
export async function listRepos(token: string | undefined, f: GhFetcher): Promise<string[]> {
  const url = token
    ? "https://api.github.com/user/repos?per_page=100&affiliation=owner&sort=pushed"
    : `https://api.github.com/users/${OWNER}/repos?per_page=100&sort=pushed`;
  try {
    const res = await f(url, { method: "GET", headers: headers(token, false) });
    if (res.status !== 200) return [];
    const body = JSON.parse(await res.text()) as Array<{ name?: string; owner?: { login?: string }; archived?: boolean }>;
    return body
      .filter((r) => r.name && (r.owner?.login ?? OWNER) === OWNER && !r.archived)
      .map((r) => String(r.name));
  } catch {
    return [];
  }
}

export interface DeliveryDeps {
  env?: Record<string, string | undefined>;
  fetcher?: GhFetcher;
  now?: () => number;
  /** Folder of pasted snapshots (tests hand in their own). */
  snapshotDir?: string;
}

export function tokenFrom(env: Record<string, string | undefined>): string | undefined {
  return env.GITHUB_LEDGER_TOKEN || env.GITHUB_USAGE_TOKEN || undefined;
}

/** Builds the whole view: known apps always, plus any other repo that has a ledger file. */
export async function loadDelivery(deps: DeliveryDeps = {}): Promise<DeliveryView> {
  const env = deps.env ?? process.env;
  const f = deps.fetcher ?? realFetch;
  const token = tokenFrom(env);
  const known = await Promise.all(KNOWN_REPOS.map((r) => fetchLedger(r, token, f)));
  const others = (await listRepos(token, f)).filter((r) => !KNOWN_REPOS.includes(r));
  const extra = (await Promise.all(others.map((r) => fetchLedger(r, token, f)))).filter((a) => a.status === "ok");
  // Open PR count per shown app (a repo the token cannot read stays null, shown as "?").
  for (const a of [...known, ...extra]) a.openPrs = await countOpenPrs(a.repo, token, f);
  // Until an app's live ledger can be read, show its pasted starting point (if any).
  for (const a of known) {
    if (a.status === "ok") continue;
    const snap = loadSnapshot(a.repo, deps.snapshotDir);
    if (snap) a.snapshot = snap;
  }
  return {
    checkedAt: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
    tokenSet: Boolean(token),
    apps: [...known, ...extra],
  };
}

let cache: DeliveryView | null = null;
let cachedAt = 0;
let inflight: Promise<DeliveryView> | null = null;

export function clearDeliveryCache(): void {
  cache = null;
  cachedAt = 0;
  inflight = null;
}

/** Cached for 10 minutes; `force` (refresh button) re-reads unless the last read was under 30 s ago. */
export async function getDelivery(force: boolean, deps: DeliveryDeps = {}): Promise<DeliveryView> {
  const now = deps.now ? deps.now() : Date.now();
  const age = now - cachedAt;
  if (cache && (force ? age < MIN_FORCED_GAP_MS : age < REFRESH_MS)) return cache;
  if (!inflight) {
    inflight = loadDelivery(deps)
      .then((v) => {
        cache = v;
        cachedAt = deps.now ? deps.now() : Date.now();
        return v;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
