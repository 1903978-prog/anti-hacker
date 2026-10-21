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

/** One number on an app's usage card (e.g. "Actions minutes: 1,210 min"). */
export interface RowMetric {
  label: string;
  value: number;
  unit: string;
  estimate?: boolean;
}

/** One repo, service or Fly app, and the app it belongs to. */
export interface UsageRow {
  /** Name at the provider (repo, service or Fly app). */
  name: string;
  /** Which of Livio's apps it is, or "other". */
  app: string;
  metrics: RowMetric[];
  note?: string;
}

/** Livio's apps, and the names they go by at each provider. nexus comes before
 *  eendigo so "nexus-eendigo" counts as nexus. */
export const APPS: { key: string; aliases: string[] }[] = [
  { key: "compplan", aliases: ["compplan"] },
  { key: "lm-op-model", aliases: ["lm-op-model", "lm-op"] },
  { key: "nexus", aliases: ["nexus"] },
  { key: "10bonds", aliases: ["10bonds"] },
  { key: "secval", aliases: ["secval", "anti-hacker"] },
  { key: "eendigo", aliases: ["eendigo"] },
];

/** Which app a repo, service or Fly app name belongs to ("other" if none). */
export function appFor(name: string, overrides: Record<string, string> = {}): string {
  const n = name.toLowerCase().replace(/^[^/]+\//, "");
  return overrides[n] ?? APPS.find((a) => a.aliases.some((x) => n.includes(x)))?.key ?? "other";
}

export interface ProviderUsage {
  id: "github" | "render" | "fly" | "neon" | "backblaze";
  name: string;
  status: UsageStatus;
  checkedAt: string;
  meters: Meter[];
  items: UsageItem[];
  /** Usage split by repo / service / Fly app, each tagged with its app. */
  rows: UsageRow[];
  /** Why this provider cannot split usage by app, if it cannot. */
  noSplit?: string;
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
  neonComputeHours: 100, // Neon Free, per project per month
  neonEgressGb: 5,
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
    rows: [],
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
    const byRepo = new Map<string, { min: number; gbh: number; usd: number }>();
    for (const it of items) {
      const product = str(it.product).toLowerCase();
      const unit = str(it.unitType).toLowerCase();
      const repo = str(it.repositoryName) || "(no repository)";
      const r = byRepo.get(repo) ?? { min: 0, gbh: 0, usd: 0 };
      byRepo.set(repo, r);
      billed += num(it.netAmount);
      r.usd += num(it.netAmount);
      if (product === "actions" && unit.includes("minute")) {
        minutes += num(it.quantity);
        r.min += num(it.quantity);
      }
      if (unit.includes("gigabyte")) {
        storageGbHours += num(it.quantity);
        r.gbh += num(it.quantity);
      }
    }
    const hoursSoFar = Math.max(1, (now.getTime() - monthStart(now).getTime()) / 3_600_000);
    const round2 = (n: number) => Math.round(n * 100) / 100;
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
      rows: [...byRepo.entries()]
        .sort((a, b) => b[1].min - a[1].min)
        .map(([name, r]) => ({
          name,
          app: appFor(name),
          metrics: [
            { label: "Actions", value: Math.round(r.min), unit: "min" },
            { label: "Storage", value: round2(r.gbh / hoursSoFar), unit: "GB" },
            { label: "Billed", value: round2(r.usd), unit: "USD" },
          ],
        })),
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
    rows: [],
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

  const suspended = services.filter((s) => str(s.suspended) === "suspended").length;

  // Outbound bandwidth since the 1st of the month, asked one service at a time
  // so it can be shown per app.
  const q = new URLSearchParams({ startTime: monthStart(now).toISOString(), endTime: now.toISOString() });
  let bwFailed: string | null = null;
  const rows: UsageRow[] = [];
  let totalGb = 0;
  for (const s of services.slice(0, 30)) {
    const id = str(s.id);
    const name = str(s.name) || id;
    const plan = str(obj(s.serviceDetails).plan);
    const note = [plan && `plan ${plan}`, str(s.suspended) === "suspended" && "SUSPENDED"].filter(Boolean).join(", ");
    let gb: number | null = null;
    if (id && !bwFailed) {
      try {
        const body = await getJson(f, `https://api.render.com/v1/metrics/bandwidth?resource=${encodeURIComponent(id)}&${q}`, headers);
        const series = Array.isArray(body) ? body : arr(obj(body).data);
        gb = 0;
        for (const sr of series.map(obj)) {
          const total = arr(sr.values).reduce<number>((sum, v) => sum + num(obj(v).value), 0);
          gb += toGb(total, str(sr.unit));
        }
        gb = Math.round(gb * 100) / 100;
        totalGb += gb;
      } catch (err) {
        bwFailed = failReason(err);
      }
    }
    rows.push({
      name,
      app: appFor(name),
      metrics: gb === null ? [] : [{ label: "Bandwidth out", value: gb, unit: "GB" }],
      note: note || undefined,
    });
  }
  const bandwidthGb = bwFailed || !rows.length ? null : Math.round(totalGb * 100) / 100;
  const bwNote = bwFailed
    ? "Could not read bandwidth: " + bwFailed
    : "All services together. Render's free amount is per workspace; check its Billing page if it looks off.";

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
    rows,
    message: `Render does not share free instance hours (${FREE.renderInstanceHours} a month) or build minutes (${FREE.renderBuildMinutes} a month) through its API; open Billing to see them. They cannot be split by app.`,
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
    rows: [],
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
    const rows: UsageRow[] = [];
    for (const app of apps.slice(0, 20)) {
      const name = str(app.name);
      if (!name) continue;
      const machines = arr(await getJson(f, `${api}/apps/${encodeURIComponent(name)}/machines`, headers)).map(obj);
      let appRunning = 0;
      let appCost = 0;
      for (const m of machines) {
        const price = flyMachineMonthly(obj(obj(m.config).guest), str(m.region));
        total++;
        alwaysOn += price;
        if (str(m.state) === "started") {
          running++;
          appRunning++;
          runningNow += price;
          appCost += price;
        }
      }
      rows.push({
        name,
        app: appFor(name),
        metrics: [
          { label: "Machines running", value: appRunning, unit: `of ${machines.length}` },
          { label: "Cost if they stay on", value: Math.round(appCost * 100) / 100, unit: "USD/month", estimate: true },
        ],
      });
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
      rows,
      message:
        "Fly has no API for the bill itself, so secval works it out from machine sizes and Fly's price list (estimate). Machines that stop when idle cost less. Volumes and data transfer are not included.",
    };
  } catch (err) {
    return { ...base, status: "error", message: "Could not read Fly machines: " + failReason(err) };
  }
}

// --- Neon ---------------------------------------------------------------------

/** "project name=app" pairs from NEON_PROJECT_APPS, for projects whose names do not say the app. */
function parseOverrides(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const [k, v] = pair.split("=").map((x) => x.trim().toLowerCase());
    if (k && v) out[k] = v;
  }
  return out;
}

export async function neonUsage(env: Env, f: Fetcher, now: Date): Promise<ProviderUsage> {
  const base: ProviderUsage = {
    id: "neon",
    name: "Neon",
    status: "not-connected",
    checkedAt: now.toISOString(),
    meters: [],
    items: [],
    rows: [],
    link: "https://console.neon.tech/app/billing",
  };
  const token = env.NEON_API_KEY;
  if (!token) return { ...base, message: "Not connected yet. Needs a Neon API key in NEON_API_KEY." };
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const api = "https://console.neon.tech/api/v2";
  const org = env.NEON_ORG_ID ? `&org_id=${encodeURIComponent(env.NEON_ORG_ID)}` : "";
  const overrides = parseOverrides(env.NEON_PROJECT_APPS);

  try {
    const list = obj(await getJson(f, `${api}/projects?limit=100${org}`, headers));
    const projects = arr(list.projects).map(obj).slice(0, 30);
    const rows: UsageRow[] = [];
    let totalHours = 0;
    let totalGb = 0;
    for (const p of projects) {
      const id = str(p.id);
      const name = str(p.name) || id;
      // The list leaves out the month's totals; the project's own page has them.
      const one = obj(obj(await getJson(f, `${api}/projects/${encodeURIComponent(id)}`, headers)).project);
      const hours = Math.round((num(one.compute_time_seconds) / 3600) * 100) / 100;
      const gb = Math.round((num(one.data_transfer_bytes) / 1e9) * 100) / 100;
      totalHours += hours;
      totalGb += gb;
      rows.push({
        name,
        app: appFor(name, overrides),
        metrics: [
          { label: "Compute", value: hours, unit: "hours", estimate: true },
          { label: "Data out", value: gb, unit: "GB" },
        ],
        note: `free: ${FREE.neonComputeHours} compute hours and ${FREE.neonEgressGb} GB out per project`,
      });
    }
    return {
      ...base,
      status: "ok",
      meters: [
        { label: "Projects", used: projects.length, limit: null, unit: "projects" },
        { label: "Compute this month, all projects", used: Math.round(totalHours * 100) / 100, limit: null, unit: "hours", estimate: true },
        { label: "Data out this month, all projects", used: Math.round(totalGb * 100) / 100, limit: null, unit: "GB" },
      ],
      rows,
      message: `Neon's free allowance is per project (${FREE.neonComputeHours} compute hours, ${FREE.neonEgressGb} GB out), so each row shows its own use. Compute hours are Neon's compute seconds divided by 3600, so they are an estimate.`,
    };
  } catch (err) {
    return { ...base, status: "error", message: "Could not read Neon usage: " + failReason(err) };
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
    rows: [],
    items: [
      { name: "Storage", detail: "10 GB free" },
      { name: "List calls (class C)", detail: "2,500 free a day, resets 00:00 UTC" },
      { name: "Read calls (class B)", detail: "2,500 free a day" },
    ],
    noSplit: "Backblaze cannot be split by app: it has no usage API, and secval's bucket holds only secval's backup.",
    message:
      "Backblaze has no API that reports these counters, so secval cannot show them. Its Caps & Alerts page shows today's use and can e-mail you before a cap is hit.",
    link: "https://secure.backblaze.com/b2_caps_alerts.htm",
  };
}

// --- All providers, cached -------------------------------------------------------

export interface AppUsage {
  app: string;
  /** One line per repo / service / Fly app, with the provider it is on. */
  lines: (UsageRow & { provider: string })[];
}

/** Every app (in the usual order, "other" last) with its rows from all providers. */
export function groupByApp(providers: ProviderUsage[]): AppUsage[] {
  const keys = [...APPS.map((a) => a.key), "other"];
  return keys
    .map((app) => ({
      app,
      lines: providers.flatMap((p) => p.rows.filter((r) => r.app === app).map((r) => ({ ...r, provider: p.name }))),
    }))
    .filter((a) => a.app !== "other" || a.lines.length);
}

/** Results are kept this long so opening the tab does not call the APIs each time. */
export const USAGE_CACHE_MS = 15 * 60_000;
/** A manual refresh is allowed at most this often. */
export const USAGE_MIN_REFRESH_MS = 60_000;

let cache: { at: number; data: ProviderUsage[] } | null = null;

export async function allUsage(
  opts: { env?: Env; fetcher?: Fetcher; now?: Date; refresh?: boolean } = {},
): Promise<{ providers: ProviderUsage[]; byApp: AppUsage[]; cachedAt: string }> {
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
      neonUsage(env, f, now),
      Promise.resolve(backblazeUsage(now)),
    ]);
    cache = { at: now.getTime(), data };
  }
  return { providers: cache.data, byApp: groupByApp(cache.data), cachedAt: new Date(cache.at).toISOString() };
}

/** For tests: forget cached results. */
export function clearUsageCache(): void {
  cache = null;
}
