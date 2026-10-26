/**
 * Dropbox backup check: looks (read-only) inside the "App backups" folder in
 * Livio's Dropbox, where the weekly backup on his PC saves each app's code and
 * database copies, and says whether the copies are there.
 *
 * Each app's cell is amber, with a plain message, when last Monday (Paris time)
 * has no code copy or no database copy. Today does not count while it is
 * Monday. The flag clears when the following Monday's copy appears.
 *
 * Only READ calls are made. The Dropbox keys come from environment variables,
 * are never stored, logged or sent to the browser, and Dropbox error bodies are
 * not passed on (only the status code). Without keys the check shows
 * "not connected" instead of failing.
 *
 * This is not scanning: it reads Livio's own account, so it does not go
 * through the scan policy engine.
 */

export type DropboxStatus = "ok" | "amber" | "not-connected" | "error";

/** The apps the PC backup saves. secval's database is kept by Litestream in Backblaze instead. */
export const BACKUP_APPS: { app: string; needsDb: boolean }[] = [
  { app: "compplan", needsDb: true },
  { app: "lm-op-model", needsDb: true },
  { app: "nexus", needsDb: true },
  { app: "10bonds", needsDb: true },
  { app: "secval", needsDb: false },
];

export interface AppCopies {
  app: string;
  status: DropboxStatus;
  message: string;
  /** Newest copy of each kind (ISO time), or null if none was found. */
  latestCode: string | null;
  latestDb: string | null;
}

export interface DropboxCheck {
  status: DropboxStatus;
  checkedAt: string;
  /** The Monday (Paris date, YYYY-MM-DD) the copies were expected on. */
  expectedMonday: string;
  apps: AppCopies[];
  message: string;
  link: string;
}

export interface DropboxResponse {
  status: number;
  json(): Promise<unknown>;
}
/** Minimal fetch shape so tests can hand in canned Dropbox answers. */
export type DropboxFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<DropboxResponse>;

type Env = Record<string, string | undefined>;

const TIMEOUT_MS = 10_000;
const realFetch: DropboxFetcher = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const LINK = "https://www.dropbox.com/home/App%20backups";

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

function failReason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 400 || err.status === 401 || err.status === 403)
      return `the Dropbox key was refused (HTTP ${err.status}); it may be wrong, expired or missing the "files.metadata.read" permission`;
    if (err.status === 429) return "too many requests right now (HTTP 429); try again later";
    return `Dropbox answered HTTP ${err.status}`;
  }
  if (err instanceof Error && err.name === "TimeoutError") return "Dropbox did not answer in time";
  return "could not reach Dropbox";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Paris calendar date (YYYY-MM-DD) of an instant. */
export function parisDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** The most recent Monday strictly before today's Paris date (today never counts). */
export function lastMonday(now: Date): string {
  const [y = 0, m = 1, d = 1] = parisDate(now).split("-").map(Number);
  const today = new Date(Date.UTC(y, m - 1, d));
  const back = ((today.getUTCDay() + 6) % 7) || 7; // Monday=0 -> 7 days back
  return new Date(today.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/** Time in a copy's file name, e.g. "compplan-db-20261026-0700Z.dump" -> 2026-10-26T07:00:00Z. */
export function parseCopyName(name: string): { app: string; kind: "code" | "db"; at: Date } | null {
  const m = /^(.+)-(code|db)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})Z\.(?:zip|dump)$/.exec(name);
  if (!m) return null;
  const [, app = "", kind = "", y, mo, d, h, mi] = m;
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  return Number.isNaN(at.getTime()) ? null : { app, kind: kind as "code" | "db", at };
}

/** Works out each app's cell from the names of the files found in the folder. */
export function judge(names: string[], now: Date): Pick<DropboxCheck, "status" | "expectedMonday" | "apps" | "message"> {
  const monday = lastMonday(now);
  const found = names.map(parseCopyName).filter((x): x is NonNullable<typeof x> => x !== null);
  const apps = BACKUP_APPS.map(({ app, needsDb }): AppCopies => {
    const mine = found.filter((f) => f.app === app);
    const newest = (kind: "code" | "db") =>
      mine.filter((f) => f.kind === kind).sort((a, b) => b.at.getTime() - a.at.getTime())[0]?.at.toISOString() ?? null;
    const onMonday = (kind: "code" | "db") => mine.some((f) => f.kind === kind && parisDate(f.at) === monday);
    const missing = [!onMonday("code") && "code", needsDb && !onMonday("db") && "database"].filter(Boolean) as string[];
    return {
      app,
      status: missing.length ? "amber" : "ok",
      message: missing.length
        ? missing.map((k) => `No ${k} copy was made on Monday ${monday}`).join(". ")
        : `Copies found for Monday ${monday}`,
      latestCode: newest("code"),
      latestDb: needsDb ? newest("db") : null,
    };
  });
  const bad = apps.filter((a) => a.status !== "ok");
  return {
    status: bad.length ? "amber" : "ok",
    expectedMonday: monday,
    apps,
    message: bad.length
      ? `${bad.map((a) => a.app).join(", ")} missing a copy from Monday ${monday}`
      : `All apps have their copies from Monday ${monday}`,
  };
}

async function post(f: DropboxFetcher, url: string, headers: Record<string, string>, body: string): Promise<unknown> {
  const res = await f(url, { method: "POST", headers, body });
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status);
  return res.json();
}

/** A short-lived access token, from the refresh token (preferred) or a plain access token. */
async function accessToken(env: Env, f: DropboxFetcher): Promise<string | null> {
  const { DROPBOX_REFRESH_TOKEN: refresh, DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret } = env;
  if (refresh && key && secret) {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: key, client_secret: secret });
    const res = obj(await post(f, "https://api.dropbox.com/oauth2/token", { "content-type": "application/x-www-form-urlencoded" }, body.toString()));
    return str(res.access_token) || null;
  }
  return env.DROPBOX_ACCESS_TOKEN || null;
}

export async function checkDropbox(
  opts: { env?: Env; fetcher?: DropboxFetcher; now?: Date } = {},
): Promise<DropboxCheck> {
  const env = opts.env ?? process.env;
  const f = opts.fetcher ?? realFetch;
  const now = opts.now ?? new Date();
  const base = { checkedAt: now.toISOString(), expectedMonday: lastMonday(now), link: LINK };
  const off: DropboxCheck = {
    ...base,
    status: "not-connected",
    apps: [],
    message:
      "Not connected yet. Needs a read-only Dropbox key: DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY and DROPBOX_APP_SECRET.",
  };
  try {
    const token = await accessToken(env, f);
    if (!token) return off;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const names: string[] = [];
    let page = obj(
      await post(f, "https://api.dropboxapi.com/2/files/list_folder", headers,
        JSON.stringify({ path: env.DROPBOX_BACKUP_FOLDER || "/App backups", recursive: true, limit: 2000 })),
    );
    for (let i = 0; i < 20; i++) {
      for (const e of Array.isArray(page.entries) ? page.entries : []) names.push(str(obj(e).name));
      if (page.has_more !== true) break;
      page = obj(await post(f, "https://api.dropboxapi.com/2/files/list_folder/continue", headers, JSON.stringify({ cursor: str(page.cursor) })));
    }
    return { ...base, ...judge(names, now) };
  } catch (err) {
    return { ...base, status: "error", apps: [], message: "Could not read Dropbox: " + failReason(err) };
  }
}

// --- cached, and checked once a day -------------------------------------------

const CACHE_MS = 15 * 60_000;
let cache: { at: number; data: DropboxCheck } | null = null;

export async function dropboxStatus(opts: { refresh?: boolean; now?: Date } = {}): Promise<DropboxCheck> {
  const now = opts.now ?? new Date();
  if (cache && !opts.refresh && now.getTime() - cache.at < CACHE_MS) return cache.data;
  const data = await checkDropbox({ now });
  cache = { at: now.getTime(), data };
  return data;
}

export function clearDropboxCache(): void {
  cache = null;
}

/** Checks Dropbox a few minutes after start and then every day; never crashes the server. */
export function startDropboxWatch(): void {
  const tick = () => {
    dropboxStatus({ refresh: true }).catch(() => {
      /* result is kept; never crash */
    });
  };
  setTimeout(tick, 6 * 60_000).unref();
  setInterval(tick, 24 * 60 * 60_000).unref();
}
