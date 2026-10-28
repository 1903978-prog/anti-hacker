/**
 * Real build/deploy signals from GitHub. A hand-written score must not look
 * good while an app's own checks are red, so when the newest finished run of
 * any workflow on an app's main branch failed, the dashboard caps that app's
 * Reliability and Deploy rows and marks them "failing now" with the run link.
 * Public repos only (no key); a private or unknown repo shows no signal.
 */
export interface FailingRun {
  name: string;
  url: string;
  at: string;
}

export interface CiSignal {
  repo: string;
  branch: string;
  checkedAt: string;
  failing: FailingRun[];
}

export type CiFetcher = (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;

const OWNER = "1903978-prog";
/** Dashboard host -> repo (and branch when it is not the repo's default). */
export const CI_REPOS: Record<string, { repo: string; branch?: string }> = {
  "10bonds.com": { repo: "10bonds" },
  "10bonds.fly.dev": { repo: "10bonds" },
  "compplan.onrender.com": { repo: "compplan" },
  "lm-op-model.fly.dev": { repo: "lm-op-model" },
  "nexus-eendigo.fly.dev": { repo: "nexus" },
  "secval.onrender.com": { repo: "anti-hacker", branch: "integration" },
};

export const FAILING_CAP = 50;
const EVERY_MS = 15 * 60_000;
const cache = new Map<string, CiSignal>();

const realFetch: CiFetcher = (url) =>
  fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "secval" },
    signal: AbortSignal.timeout(10_000),
  });

export function getCiSignal(host: string): CiSignal | null {
  return cache.get(host) ?? null;
}

/** Test helper. */
export function setCiSignal(host: string, signal: CiSignal | null): void {
  if (signal) cache.set(host, signal);
  else cache.delete(host);
}

interface Run {
  name?: string;
  conclusion?: string | null;
  status?: string;
  html_url?: string;
  event?: string;
  updated_at?: string;
}

/** Newest finished run of each workflow on the branch; failing ones are returned. */
export async function fetchCiSignal(host: string, fetcher: CiFetcher = realFetch): Promise<CiSignal | null> {
  const entry = CI_REPOS[host];
  if (!entry) return null;
  const base = `https://api.github.com/repos/${OWNER}/${entry.repo}`;
  let branch = entry.branch;
  if (!branch) {
    const r = await fetcher(base);
    if (r.status !== 200) return null;
    branch = String(((await r.json()) as { default_branch?: string }).default_branch ?? "main");
  }
  const res = await fetcher(
    `${base}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=40`,
  );
  if (res.status !== 200) return null;
  const runs = ((await res.json()) as { workflow_runs?: Run[] }).workflow_runs ?? [];
  const newest = new Map<string, Run>();
  for (const run of runs) {
    // Pull-request runs are not the app's main branch; skip them.
    if (!run.name || run.event === "pull_request") continue;
    if (run.conclusion === "cancelled" || run.conclusion === "skipped") continue;
    if (!newest.has(run.name)) newest.set(run.name, run);
  }
  const failing = [...newest.values()]
    .filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out")
    .map((r) => ({ name: r.name!, url: r.html_url ?? `https://github.com/${OWNER}/${entry.repo}/actions`, at: r.updated_at ?? "" }));
  return { repo: entry.repo, branch, checkedAt: new Date().toISOString(), failing };
}

export async function refreshCi(fetcher: CiFetcher = realFetch): Promise<void> {
  for (const host of Object.keys(CI_REPOS)) {
    try {
      const s = await fetchCiSignal(host, fetcher);
      if (s) cache.set(host, s);
      else cache.delete(host);
    } catch {
      // Keep the last known signal; GitHub being slow must not break the dashboard.
    }
  }
}

export function startCiWatch(): void {
  void refreshCi();
  setInterval(() => void refreshCi(), EVERY_MS).unref();
}
