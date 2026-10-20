/**
 * Usage counters: how much of each hosting account's free allowance is used
 * this month (GitHub, Render, Fly, Backblaze), so costs and limits can be
 * watched from secval.
 *
 * Only READ calls (HTTP GET) are made, with tokens read from environment
 * variables. Tokens are never stored, logged or sent to the browser, and
 * provider error bodies are not passed on (only the status code). A provider
 * without a token shows "not connected" instead of failing.
 *
 * This is not scanning: it reads Livio's own account data from the providers'
 * APIs, so it does not go through the scan policy engine.
 */

export type UsageStatus = "ok" | "not-connected" | "error" | "info";

export interface Meter {
  label: string;
  /** Amount used so far; null when the provider could not say. */
  used: number | null;
  /** Free allowance (or limit); null when there is none to compare with. */
  limit: number | null;
  unit: string;
  /** True when the number is worked out by secval, not reported by the provider. */
  estimate?: boolean;
  note?: string;
}

export interface UsageItem {
  name: string;
  detail: string;
}

export interface ProviderUsage {
  id: "github" | "render" | "fly" | "backblaze";
  name: string;
  status: UsageStatus;
  checkedAt: string;
  meters: Meter[];
  items: UsageItem[];
  /** Short plain-language message (why not connected, what failed, a caveat). */
  message?: string;
  /** Where to see the provider's own numbers. */
  link: string;
}

/** Minimal fetch shape so tests can hand in canned API answers. */
export type Fetcher = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const TIMEOUT_MS = 10_000;

const realFetch: Fetcher = (url, init) =>
  fetch(url, { method: "GET", headers: init.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });

type Env = Record<string, string | undefined>;

/** Free allowances, from each provider's pricing page (checked 2026-10-20). */
export const FREE = {
  githubActionsMinutes: 2000, // GitHub Free, private repos; public repos are free
  renderBandwidthGb: 5, // Render Hobby workspace, per month
  renderBuildMinutes: 500,
  renderInstanceHours: 750,
};

/** Fly machine prices (USD/month, always on, iad region), docs.fly.io/about/pricing. */
const FLY_RAM_PER_GB = 6;
const FLY_CPU = { shared: 0.69, performance: 21 } as const;
const FLY_REGION_FACTOR: Record<string, number> = { cdg: 1.13, ams: 1.04 };

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

async function getJson(f: Fetcher, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await f(url, { headers });
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status);
  return res.json();
}

/** Plain-language reason for a failed call; never includes the token. */
function failReason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return `the token was refused (HTTP ${err.status}); it may be wrong, expired or missing a permission`;
    if (err.status === 404) return "not found (HTTP 404)";
    if (err.status === 429) return "too many requests right now (HTTP 429); try again later";
    return `the provider answered HTTP ${err.status}`;
  }
  if (err instanceof Error && err.name === "TimeoutError") return "the provider did not answer in time";
  return "could not reach the provider";
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// --- GitHub -------------------------------------------------------------------

export async function githubUsage(env: Env, f: Fetcher, now: Date): Promise<ProviderUsage> {
  const user = env.GITHUB_USAGE_USER || "1903978-prog";
  const base: ProviderUsage = {
    id: "github",
    name: "GitHub",
    status: "not-connected",
    checkedAt: now.toISOString(),
    meters: [],
    items: [],
    link: "https://github.com/settings/billing/usage",
  };
  const token = env.GITHUB_USAGE_TOKEN;
  if (!token) return { ...base, message: "Not connected yet. Needs a read-only GitHub token in GITHUB_USAGE_TOKEN." };

  const url =
    `https://api.github.com/users/${encodeURIComponent(user)}/settings/billing/usage` +
    `?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
  try {
    const body = obj(
      await getJson(f, url, {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "secval",
      }),
    );
    const items = arr(body.usageItems).map(obj);
    let minutes = 0;
    let billed = 0;
    let storageGbHours = 0;
    const byRepo = new Map<string, number>();
    for (const it of items) {
      const product = str(it.product).toLowerCase();
      const unit = str(it.unitType).toLowerCase();
      billed += num(it.netAmount);
      if (product === "actions" && unit.includes("minute")) {
        minutes += num(it.quantity);
        const repo = str(it.repositoryName) || "(no repository)";
        byRepo.set(repo, (byRepo.get(repo) ?? 0) + num(it.quantity));
      }
      if (unit.includes("gigabyte")) storageGbHours += num(it.quantity);
    }
    const hoursSoFar = Math.max(1, (now.getTime() - monthStart(now).getTime()) / 3_600_000);
    return {
      ...base,
      status: "ok",
      meters: [
        {
          label: "Actions minutes this month",
          used: Math.round(minutes),
          limit: FREE.githubActionsMinutes,
          unit: "min",
          note: "Counts all repos. Public repos are free, so the real use of the free 2,000 is the same or lower.",
        },
        {
          label: "Storage (Actions and Packages), average",
          used: Math.round((storageGbHours / hoursSoFar) * 100) / 100,
          limit: 0.5,
          unit: "GB",
        },
        { label: "Billed this month", used: Math.round(billed * 100) / 100, limit: null, unit: "USD" },
      ],
      items: [...byRepo.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, m]) => ({ name, detail: `${Math.round(m)} min` })),
    };
  } catch (err) {
    return { ...base, status: "error", message: "Could not read GitHub usage: " + failReason(err) };
  }
}

// --- Render ------------------------------------------------------------------

/** Converts a Render bandwidth series total to GB, from the unit it reports (MB if none). */
function toGb(total: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === "b" || u.startsWith("byte")) return total / 1e9;
  if (u === "kb") return total / 1e6;
  if (u === "gb") return total;
  return total / 1000; // "mb" or unknown
}

export async function renderUsage(env: Env, f: Fetcher, now: Date): Promise<ProviderUsage> {
  const base: ProviderUsage = {
    id: "render",
    name: "Render",
    status: "not-connected",
    checkedAt: now.toISOString(),
    meters: [],
    items: [],
    link: "https://dashboard.render.com/billing",
  };
  const token = env.RENDER_API_KEY;
  if (!token) return { ...base, message: "Not connected yet. Needs a Render API key in RENDER_API_KEY." };
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };

  let services: Record<string, unknown>[];
  try {
    const list = arr(await getJson(f, "https://api.render.com/v1/services?limit=100", headers));
    services = list.map((row) => obj(obj(row).service ?? row));
  } catch (err) {
    return { ...base, status: "error", message: "Could not read Render services: " + failReason(err) };
  }

  const items = services.map((s) => {
    const plan = str(obj(s.serviceDetails).plan) || "—";
    const suspended = str(s.suspended) === "suspended";
    return {
      name: str(s.name) || str(s.id),
      detail: `${str(s.type) || "service"}, plan ${plan}${suspended ? ", SUSPENDED" : ""}`,
    };
  });
  const suspended = services.filter((s) => str(s.suspended) === "suspended").length;

  // Outbound bandwidth since the 1st of the month, all services together.
  let bandwidthGb: number | null = null;
  let bwNote = "All services together. Render's free amount is per workspace; check its Billing page if it looks off.";
  const ids = services.map((s) => str(s.id)).filter(Boolean);
  if (ids.length) {
    const q = new URLSearchParams();
    for (const id of ids) q.append("resource", id);
    q.set("startTime", monthStart(now).toISOString());
    q.set("endTime", now.toISOString());
    try {
      const body = await getJson(f, `https://api.render.com/v1/metrics/bandwidth?${q}`, headers);
      const series = Array.isArray(body) ? body : arr(obj(body).data);
      let gb = 0;
      for (const s of series.map(obj)) {
        const total = arr(s.values).reduce<number>((sum, v) => sum + num(obj(v).value), 0);
        gb += toGb(total, str(s.unit));
      }
      bandwidthGb = Math.round(gb * 100) / 100;
    } catch (err) {
      bwNote = "Could not read bandwidth: " + failReason(err);
    }
  }

  return {
    ...base,
    status: "ok",
    meters: [
      { label: "Outbound bandwidth this month", used: bandwidthGb, limit: FREE.renderBandwidthGb, unit: "GB", note: bwNote },
      {
        label: "Services",
        used: services.length,
        limit: null,
        unit: suspended ? `services, ${suspended} suspended` : "services",
      },
    ],
    items,
    message: `Render does not share free instance hours (${FREE.renderInstanceHours} a month) or build minutes (${FREE.renderBuildMinutes} a month) through its API; open Billing to see them.`,
  };
}

// --- Fly ------------------------------------------------------------------------

/** Monthly price of one machine if it ran all month (USD, estimate). */
export function flyMachineMonthly(guest: Record<string, unknown>, region: string): number {
  const kind = str(guest.cpu_kind) === "performance" ? "performance" : "shared";
  const cpus = num(guest.cpus) || 1;
  const memGb = (num(guest.memory_mb) || 256) / 1024;
  return (cpus * FLY_CPU[kind] + memGb * FLY_RAM_PER_GB) * (FLY_REGION_FACTOR[region] ?? 1);
}

export async function flyUsage(env: Env, f: Fetcher, now: Date): Promise<ProviderUsage> {
  const org = env.FLY_ORG || "personal";
  const base: ProviderUsage = {
    id: "fly",
    name: "Fly.io",
    status: "not-connected",
    checkedAt: now.toISOString(),
    meters: [],
    items: [],
    link: `https://fly.io/dashboard/${encodeURIComponent(org)}/billing`,
  };
  const token = env.FLY_API_TOKEN;
  if (!token) return { ...base, message: "Not connected yet. Needs a read-only Fly token in FLY_API_TOKEN." };
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const api = "https://api.machines.dev/v1";

  try {
    const body = obj(await getJson(f, `${api}/apps?org_slug=${encodeURIComponent(org)}`, headers));
    const apps = arr(body.apps).map(obj);
    let total = 0;
    let running = 0;
    let alwaysOn = 0;
    let runningNow = 0;
    const items: UsageItem[] = [];
    for (const app of apps.slice(0, 20)) {
      const name = str(app.name);
      if (!name) continue;
      const machines = arr(await getJson(f, `${api}/apps/${encodeURIComponent(name)}/machines`, headers)).map(obj);
      let appRunning = 0;
      for (const m of machines) {
        const price = flyMachineMonthly(obj(obj(m.config).guest), str(m.region));
        total++;
        alwaysOn += price;
        if (str(m.state) === "started") {
          running++;
          appRunning++;
          runningNow += price;
        }
      }
      items.push({ name, detail: `${machines.length} machine(s), ${appRunning} running now` });
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      ...base,
      status: "ok",
      meters: [
        { label: "Machines running now", used: running, limit: null, unit: `of ${total} machines` },
        {
          label: "Monthly cost if the running machines stay on",
          used: round(runningNow),
          limit: null,
          unit: "USD",
          estimate: true,
        },
        {
          label: "Most it could cost if all machines ran all month",
          used: round(alwaysOn),
          limit: null,
          unit: "USD",
          estimate: true,
        },
      ],
      items,
      message:
        "Fly has no API for the bill itself, so secval works it out from machine sizes and Fly's price list (estimate). Machines that stop when idle cost less. Volumes and data transfer are not included.",
    };
  } catch (err) {
    return { ...base, status: "error", message: "Could not read Fly machines: " + failReason(err) };
  }
}

// --- Backblaze -------------------------------------------------------------------

export function backblazeUsage(now: Date): ProviderUsage {
  return {
    id: "backblaze",
    name: "Backblaze B2",
    status: "info",
    checkedAt: now.toISOString(),
    meters: [],
    items: [
      { name: "Storage", detail: "10 GB free" },
      { name: "List calls (class C)", detail: "2,500 free a day, resets 00:00 UTC" },
      { name: "Read calls (class B)", detail: "2,500 free a day" },
    ],
    message:
      "Backblaze has no API that reports these counters, so secval cannot show them. Its Caps & Alerts page shows today's use and can e-mail you before a cap is hit.",
    link: "https://secure.backblaze.com/b2_caps_alerts.htm",
  };
}

// --- All providers, cached -------------------------------------------------------

/** Results are kept this long so opening the tab does not call the APIs each time. */
export const USAGE_CACHE_MS = 15 * 60_000;
/** A manual refresh is allowed at most this often. */
export const USAGE_MIN_REFRESH_MS = 60_000;

let cache: { at: number; data: ProviderUsage[] } | null = null;

export async function allUsage(
  opts: { env?: Env; fetcher?: Fetcher; now?: Date; refresh?: boolean } = {},
): Promise<{ providers: ProviderUsage[]; cachedAt: string }> {
  const now = opts.now ?? new Date();
  const age = cache ? now.getTime() - cache.at : Infinity;
  const fresh = age < (opts.refresh ? USAGE_MIN_REFRESH_MS : USAGE_CACHE_MS);
  if (!cache || !fresh) {
    const env = opts.env ?? process.env;
    const f = opts.fetcher ?? realFetch;
    const data = await Promise.all([
      githubUsage(env, f, now),
      renderUsage(env, f, now),
      flyUsage(env, f, now),
      Promise.resolve(backblazeUsage(now)),
    ]);
    cache = { at: now.getTime(), data };
  }
  return { providers: cache.data, cachedAt: new Date(cache.at).toISOString() };
}

/** For tests: forget cached results. */
export function clearUsageCache(): void {
  cache = null;
}
