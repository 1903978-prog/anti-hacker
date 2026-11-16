/**
 * Delivery ledger (16 Nov 2026, Livio): shows each app's docs/delivery-ledger.json
 * (written by the /een-code skill) as one table per app.
 *
 * READ-ONLY: this module only sends GET requests to the GitHub API. It never
 * writes to any repository. The token comes from GITHUB_LEDGER_TOKEN, falling
 * back to the read-only GITHUB_USAGE_TOKEN already in the Render env group.
 * The token is never logged, returned or shown.
 */
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
}

export interface AppLedger {
  repo: string;
  project: string;
  /** ok = file read; missing = repo has no ledger file yet; no-access = token cannot read it; error = bad file or GitHub failure. */
  status: "ok" | "missing" | "no-access" | "error";
  message?: string;
  lastSynced?: string;
  link: string;
  atoms: Atom[];
  counts: { total: number; done: number; open: number } & Record<StageKey, number>;
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
});
const LedgerIn = z.object({
  project: text.optional(),
  repo: text.optional(),
  last_synced: text.optional(),
  atoms: z.array(z.unknown()),
});

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
      done: STAGES.every((k) => stages[k] === "yes"),
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
    atoms: [],
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

/** Reads one repo's ledger file from its default branch (GET only). */
export async function fetchLedger(repo: string, token: string | undefined, f: GhFetcher): Promise<AppLedger> {
  const url = `https://api.github.com/repos/${OWNER}/${encodeURIComponent(repo)}/contents/${LEDGER_PATH}`;
  try {
    const res = await f(url, { method: "GET", headers: headers(token, true) });
    if (res.status === 200) return parseLedger(repo, await res.text());
    if (res.status === 404) {
      // 404 also means "no access" on a private repo; the repo check tells them apart.
      const r = await f(`https://api.github.com/repos/${OWNER}/${encodeURIComponent(repo)}`, {
        method: "GET",
        headers: headers(token, false),
      });
      if (r.status === 200) return { ...baseApp(repo), status: "missing", message: "No ledger file in this repository yet." };
      return {
        ...baseApp(repo),
        status: "no-access",
        message: token
          ? "The GitHub token cannot read this repository."
          : "No GitHub token set, so this private repository cannot be read.",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ...baseApp(repo), status: "no-access", message: `GitHub refused the request (${res.status}).` };
    }
    return { ...baseApp(repo), status: "error", message: `GitHub answered ${res.status}.` };
  } catch {
    return { ...baseApp(repo), status: "error", message: "GitHub could not be reached." };
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
