/**
 * Dropbox backup check: looks (read-only) at Livio's Dropbox, where each app's
 * code and database copies are kept, and says whether there are enough recent
 * copies. Checked once a day; the result drives the red warning at the top of
 * the secval page.
 *
 * Rule (Livio, 14 Nov 2026): every app needs at least 2 recent code copies and
 * 2 recent database copies. "Recent" here: both copies made in the last
 * WINDOW_DAYS days and the newest at most NEWEST_MAX_DAYS days old (Paris
 * dates). An empty file does not count. A missing, empty or stale folder is a
 * failure (red), never "ok".
 *
 * Where it looks: "/backups nov26" (Livio, 14 Nov 2026: the one folder every
 * app backs up into, one subfolder per app), recursively. Copies left only in
 * the old folders ("/App backups", "/Apps/LM CLAUDE BACK UP") do not count. It reads every
 * naming style used so far: "261112-lm-op-model-db.dump.enc" (central),
 * "261113-nexus-db.zip" (old GitHub backups) and
 * "compplan-db-20261026-0700Z.dump" (old PC script). It also reads the central
 * backup's own "status.json" and turns any problem it records (for example
 * Dropbox full) into a red line, because that file said "overdue: []" on
 * 13 Nov 2026 while every code upload had failed.
 *
 * secval's own database lives in Backblaze (checked by the daily restore test
 * on this page), so only its code copies are counted here.
 *
 * Only READ calls are made. The keys come from environment variables, are never
 * stored, logged or sent to the browser, and Dropbox error bodies are not passed
 * on (only the status code).
 *
 * This is not scanning: it reads Livio's own account, so it does not go through
 * the scan policy engine.
 */

export type DropboxStatus = "ok" | "red" | "not-connected" | "error";

export const MIN_COPIES = 2;
export const WINDOW_DAYS = 8;
export const NEWEST_MAX_DAYS = 2;

/** The apps whose copies are checked. secval's database is kept by Litestream in Backblaze instead. */
export const BACKUP_APPS: { app: string; needsDb: boolean }[] = [
  { app: "compplan", needsDb: true },
  { app: "lm-op-model", needsDb: true },
  { app: "nexus", needsDb: true },
  { app: "10bonds", needsDb: true },
  { app: "secval", needsDb: false },
];

/** Livio, 14 Nov 2026: every app backs up into ONE folder, one subfolder per app. */
export const DEFAULT_FOLDERS = ["/backups nov26"];

export interface AppCopies {
  app: string;
  status: DropboxStatus;
  message: string;
  /** Plain-language problems for the red warning, empty when ok. */
  problems: string[];
  /** Newest copy of each kind (ISO time), or null if none was found. */
  latestCode: string | null;
  latestDb: string | null;
  /** Usable copies made in the last WINDOW_DAYS days. */
  recentCode: number;
  recentDb: number | null;
}

export interface DropboxCheck {
  status: DropboxStatus;
  checkedAt: string;
  rule: string;
  folders: string[];
  apps: AppCopies[];
  message: string;
  /** Lines from the central backup's status.json, or why it could not be read. */
  centralNote: string;
  link: string;
}

export interface FileEntry {
  name: string;
  size?: number;
  path?: string;
}

export interface DropboxResponse {
  status: number;
  json(): Promise<unknown>;
}
/** Minimal fetch shape so tests can hand in canned Dropbox answers. */
export type DropboxFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body?: string },
) => Promise<DropboxResponse>;

type Env = Record<string, string | undefined>;

const TIMEOUT_MS = 10_000;
const realFetch: DropboxFetcher = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const LINK = "https://www.dropbox.com/home/backups%20nov26";
const RULE =
  `Each app needs at least ${MIN_COPIES} code copies and ${MIN_COPIES} database copies made in the last ${WINDOW_DAYS} days, ` +
  `the newest at most ${NEWEST_MAX_DAYS} days old. Empty files do not count.`;

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14 Nov 2026" (Livio's date rule) from a Paris date YYYY-MM-DD. */
export function showDate(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d} ${MONTHS[Number(m) - 1] ?? "?"} ${y}`;
}

/** Whole days between two Paris dates. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

/**
 * Reads a copy's file name. Three styles:
 *  "261112-lm-op-model-db.dump.enc" / "261113-nexus-code.zip" (date first)
 *  "compplan-db-20261026-0700Z.dump" (old PC script)
 * Returns null for anything else (history bundles, logs, status files).
 */
export function parseCopyName(name: string): { app: string; kind: "code" | "db"; at: Date } | null {
  let m = /^(\d{2})(\d{2})(\d{2})-(.+)-(code|db)\.(?:zip|dump)(?:\.enc)?$/.exec(name);
  if (m) {
    const [, y, mo, d, app = "", kind = ""] = m;
    const at = new Date(Date.UTC(2000 + Number(y), Number(mo) - 1, Number(d), 12));
    if (Number.isNaN(at.getTime()) || at.getUTCDate() !== Number(d)) return null;
    return { app, kind: kind as "code" | "db", at };
  }
  m = /^(.+)-(code|db)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})Z\.(?:zip|dump)(?:\.enc)?$/.exec(name);
  if (!m) return null;
  const [, app = "", kind = "", y, mo, d, h, mi] = m;
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  return Number.isNaN(at.getTime()) ? null : { app, kind: kind as "code" | "db", at };
}

/** Problems recorded by the central backup in its status.json. */
export function centralProblems(status: unknown, now: Date): { byApp: Map<string, string[]>; note: string } {
  const byApp = new Map<string, string[]>();
  const s = obj(status);
  const runAt = str(s.runAt);
  if (!runAt) return { byApp, note: "The central backup's status file has no run time." };
  const runDay = parisDate(new Date(runAt));
  const age = daysBetween(runDay, parisDate(now));
  const notes = [`Central backup last ran on ${showDate(runDay)}.`];
  for (const [app, raw] of Object.entries(obj(s.apps))) {
    const a = obj(raw);
    const p: string[] = [];
    const code = obj(a.code);
    const db = obj(a.db);
    const plain = (x: string) => (/insufficient_space/.test(x) ? "Dropbox is full" : x);
    if (str(code.problem)) p.push(`the last code copy failed to save (${plain(str(code.problem))})`);
    if (str(db.problem)) p.push(`the last database copy failed to save (${plain(str(db.problem))})`);
    if (!p.length && str(a.problem)) p.push(`the last run reported a problem (${plain(str(a.problem))})`);
    if (p.length) byApp.set(app, p);
  }
  if (age > NEWEST_MAX_DAYS) {
    for (const { app } of BACKUP_APPS) if (app !== "secval") {
      const list = byApp.get(app) ?? [];
      list.push(`the central backup has not run since ${showDate(runDay)}`);
      byApp.set(app, list);
    }
  }
  return { byApp, note: notes.join(" ") };
}

/** Works out each app's cell from the files found and the central status file. */
export function judge(
  files: (FileEntry | string)[],
  now: Date,
  central: Map<string, string[]> = new Map(),
): Pick<DropboxCheck, "status" | "apps" | "message"> {
  const today = parisDate(now);
  const found = files
    .map((f) => (typeof f === "string" ? { name: f } : f))
    .filter((f) => f.size === undefined || f.size > 0)
    .map((f) => parseCopyName(f.name))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const apps = BACKUP_APPS.map(({ app, needsDb }): AppCopies => {
    const mine = found.filter((f) => f.app === app);
    const problems: string[] = [];
    const look = (kind: "code" | "db", label: string) => {
      const all = mine.filter((f) => f.kind === kind).sort((a, b) => b.at.getTime() - a.at.getTime());
      // one copy per day: two files of the same day are one copy
      const days = [...new Set(all.map((f) => parisDate(f.at)))];
      const recent = days.filter((d) => daysBetween(d, today) <= WINDOW_DAYS).length;
      const newest = days[0];
      if (!newest) problems.push(`no ${label} copy found at all`);
      else {
        if (recent < MIN_COPIES)
          problems.push(`only ${recent} ${label} cop${recent === 1 ? "y" : "ies"} in the last ${WINDOW_DAYS} days (needs ${MIN_COPIES})`);
        const age = daysBetween(newest, today);
        if (age > NEWEST_MAX_DAYS) problems.push(`newest ${label} copy is from ${showDate(newest)} (${age} days old)`);
      }
      return { latest: all[0]?.at.toISOString() ?? null, recent };
    };
    const code = look("code", "code");
    const db = needsDb ? look("db", "database") : null;
    for (const p of central.get(app) ?? []) problems.push(p);
    return {
      app,
      status: problems.length ? "red" : "ok",
      message: problems.length ? problems.join("; ") : `${MIN_COPIES}+ recent copies of everything`,
      problems,
      latestCode: code.latest,
      latestDb: db?.latest ?? null,
      recentCode: code.recent,
      recentDb: db?.recent ?? null,
    };
  });
  const bad = apps.filter((a) => a.status !== "ok");
  return {
    status: bad.length ? "red" : "ok",
    apps,
    message: bad.length
      ? `BACKUP FAILURE: ${bad.map((a) => a.app).join(", ")} ${bad.length === 1 ? "does" : "do"} not have enough recent copies`
      : `Every app has at least ${MIN_COPIES} recent code and database copies`,
  };
}

async function post(f: DropboxFetcher, url: string, headers: Record<string, string>, body?: string): Promise<unknown> {
  // No body at all for content downloads: a string body makes fetch send text/plain, which Dropbox refuses (400).
  const res = await f(url, body === undefined ? { method: "POST", headers } : { method: "POST", headers, body });
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

/** Names only (never values): which of the three variables are missing or empty, and any similar names that are set. */
export function missingNote(env: Env): string {
  const need = ["DROPBOX_REFRESH_TOKEN", "DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"];
  const missing = need.filter((k) => !env[k]);
  const similar = Object.keys(env).filter((k) => /dropbox/i.test(k) && !need.includes(k));
  const parts = [`Missing or empty: ${missing.join(", ") || "none"}.`];
  if (similar.length) parts.push(`Set under other names: ${similar.map((k) => JSON.stringify(k)).join(", ")}.`);
  return " " + parts.join(" ");
}

async function listFolder(f: DropboxFetcher, headers: Record<string, string>, path: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  let page = obj(
    await post(f, "https://api.dropboxapi.com/2/files/list_folder", headers,
      JSON.stringify({ path, recursive: true, limit: 2000 })),
  );
  for (let i = 0; i < 50; i++) {
    for (const raw of Array.isArray(page.entries) ? page.entries : []) {
      const e = obj(raw);
      if (str(e[".tag"]) && str(e[".tag"]) !== "file") continue;
      out.push({ name: str(e.name), size: typeof e.size === "number" ? e.size : undefined, path: str(e.path_display) });
    }
    if (page.has_more !== true) break;
    page = obj(await post(f, "https://api.dropboxapi.com/2/files/list_folder/continue", headers, JSON.stringify({ cursor: str(page.cursor) })));
  }
  return out;
}

export async function checkDropbox(
  opts: { env?: Env; fetcher?: DropboxFetcher; now?: Date } = {},
): Promise<DropboxCheck> {
  const env = opts.env ?? process.env;
  const f = opts.fetcher ?? realFetch;
  const now = opts.now ?? new Date();
  const folders = env.DROPBOX_BACKUP_FOLDER
    ? env.DROPBOX_BACKUP_FOLDER.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_FOLDERS;
  const base = { checkedAt: now.toISOString(), rule: RULE, folders, link: LINK, centralNote: "" };
  const off: DropboxCheck = {
    ...base,
    status: "not-connected",
    apps: [],
    message:
      "Backup copies cannot be checked: Dropbox is not connected. Needs a read-only Dropbox key: DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY and DROPBOX_APP_SECRET." +
      missingNote(env),
  };
  try {
    const token = await accessToken(env, f);
    if (!token) return off;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const files: FileEntry[] = [];
    const missingFolders: string[] = [];
    for (const folder of folders) {
      try {
        files.push(...(await listFolder(f, headers, folder)));
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) missingFolders.push(folder);
        else throw err;
      }
    }
    if (missingFolders.length === folders.length)
      return { ...base, status: "error", apps: [], message: `BACKUP FAILURE: none of the backup folders exist (${folders.join(", ")})` };
    let central = new Map<string, string[]>();
    let centralNote = "";
    const statusPath = `${folders[0]}/status.json`.toLowerCase();
    const statusFile = files.find((x) => x.name === "status.json" && (x.path ?? "").toLowerCase() === statusPath);
    if (statusFile) {
      try {
        const body = await post(f, "https://content.dropboxapi.com/2/files/download",
          { authorization: headers.authorization, "Dropbox-API-Arg": JSON.stringify({ path: statusFile.path }) });
        const c = centralProblems(body, now);
        central = c.byApp;
        centralNote = c.note;
      } catch (err) {
        centralNote = "Could not read the central backup's status file: " + failReason(err) + ".";
      }
    } else centralNote = "The central backup's status file was not found.";
    if (missingFolders.length) centralNote += ` Folder not found: ${missingFolders.join(", ")}.`;
    return { ...base, centralNote: centralNote.trim(), ...judge(files, now, central) };
  } catch (err) {
    return { ...base, status: "error", apps: [], message: "BACKUP CHECK FAILED: could not read Dropbox: " + failReason(err) };
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
