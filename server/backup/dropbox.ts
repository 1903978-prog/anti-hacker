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
 * "261120-compplan-code~161208956-4d5720.zip.enc" (central since 20 Nov 2026, run id after "~"),
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
 * on (only the status code, plus the name of a missing permission when Dropbox states one).
 *
 * This is not scanning: it reads Livio's own account, so it does not go through
 * the scan policy engine.
 */
import { attestationKey, verifyCopy } from "./attestation.js";
import { requiredSlot } from "./schedule.js";

export type DropboxStatus = "ok" | "red" | "not-connected" | "error";

export const MIN_COPIES = 2;
/** Weekly schedule (Monday 08:00 Bangkok): two generations are 15 days; the newest must be from the slot that is due (12 h grace). */
export const WINDOW_DAYS = 15;

/** The apps whose copies are checked: the four subfolders of "backups nov26" (checked 14 Nov 2026).
 * secval is not one of them: its database is kept by Litestream in Backblaze and nothing copies its code there. */
export const BACKUP_APPS: { app: string; needsDb: boolean }[] = [
  { app: "compplan", needsDb: true },
  { app: "lm-op-model", needsDb: true },
  { app: "nexus", needsDb: true },
  { app: "10bonds", needsDb: true },
];

/** The four apps, plus secval itself once its own Dropbox copy is switched on (SECVAL_SECOND_COPY=on, see secondCopy.ts). */
export function appsChecked(env: Env): { app: string; needsDb: boolean }[] {
  return env.SECVAL_SECOND_COPY === "on" ? [...BACKUP_APPS, { app: "secval", needsDb: true }] : BACKUP_APPS;
}

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
  /** Dropbox's content_hash of the stored bytes (from the folder listing). */
  contentHash?: string;
}

export interface DropboxResponse {
  status: number;
  json(): Promise<unknown>;
  /** Plain-text error body (Dropbox explains a 400 this way). Only matched against known reasons, never shown. */
  text?(): Promise<string>;
}
/** Minimal fetch shape so tests can hand in canned Dropbox answers. */
export type DropboxFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body?: string },
) => Promise<DropboxResponse>;

export type Env = Record<string, string | undefined>;

const TIMEOUT_MS = 10_000;
const realFetch: DropboxFetcher = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const LINK = "https://www.dropbox.com/home/backups%20nov26";
const RULE =
  `Each app needs at least ${MIN_COPIES} code copies and ${MIN_COPIES} database copies made in the last ${WINDOW_DAYS} days, ` +
  `the newest from the latest Monday 08:00 Bangkok backup (12 hours grace). Empty files do not count.`;

class HttpError extends Error {
  constructor(public status: number, public missingScope: string | null = null) {
    super(`HTTP ${status}`);
  }
}

/**
 * The permission Dropbox names when the app itself lacks it (a 400 with a plain-text body such as
 * "... does not have the required scope 'files.content.read' ..."). Only a scope name is kept, never the body.
 */
export function scopeFromError(body: string): string | null {
  const m = /required scope ['"]?([a-z_]+(?:\.[a-z_]+)+)['"]?/i.exec(body);
  return m ? m[1]!.toLowerCase() : null;
}

function failReason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.missingScope)
      return `Secval's Dropbox app is not allowed to use "${err.missingScope}" (HTTP ${err.status}); tick it in the app's Permissions tab in the Dropbox App Console, press Submit, then press "Reconnect Dropbox" on this page`;
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

function parseCentralRunAt(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearPart, monthPart, dayPart, hourPart, minutePart, secondPart] = match;
  if (!yearPart || !monthPart || !dayPart || !hourPart || !minutePart || !secondPart) return null;
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
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
  let m = /^(\d{2})(\d{2})(\d{2})-(.+)-(code|db)(?:~[A-Za-z0-9-]+)?\.(?:zip|dump)(?:\.enc)?$/.exec(name);
  if (m) {
    const [, y, mo, d, app = "", kind = ""] = m;
    const at = new Date(Date.UTC(2000 + Number(y), Number(mo) - 1, Number(d), 12));
    if (
      Number.isNaN(at.getTime()) ||
      at.getUTCFullYear() !== 2000 + Number(y) ||
      at.getUTCMonth() !== Number(mo) - 1 ||
      at.getUTCDate() !== Number(d)
    ) return null;
    return { app, kind: kind as "code" | "db", at };
  }
  m = /^(.+)-(code|db)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})Z\.(?:zip|dump)(?:\.enc)?$/.exec(name);
  if (!m) return null;
  const [, app = "", kind = "", y, mo, d, h, mi] = m;
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  if (
    Number.isNaN(at.getTime()) ||
    at.getUTCFullYear() !== Number(y) ||
    at.getUTCMonth() !== Number(mo) - 1 ||
    at.getUTCDate() !== Number(d) ||
    at.getUTCHours() !== Number(h) ||
    at.getUTCMinutes() !== Number(mi)
  ) return null;
  return { app, kind: kind as "code" | "db", at };
}

/** Problems recorded by the central backup in its status.json. */
export function centralProblems(status: unknown, now: Date): { byApp: Map<string, string[]>; note: string } {
  const byApp = new Map<string, string[]>();
  const s = obj(status);
  const flagAllApps = (problem: string, note: string) => {
    for (const { app } of BACKUP_APPS) byApp.set(app, [problem]);
    return { byApp, note };
  };
  const runAt = str(s.runAt);
  if (!runAt)
    return flagAllApps("the central backup status has no valid run time", "The central backup's status file has no run time.");
  const runTime = parseCentralRunAt(runAt);
  if (runTime === null)
    return flagAllApps("the central backup status has an invalid run time", "The central backup's status file has an invalid run time.");
  const runDay = parisDate(new Date(runTime));
  if (runTime > now.getTime())
    return flagAllApps("the central backup run time is in the future", `The central backup's status file is future-dated (${showDate(runDay)}).`);
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
  // 20 Nov 2026: Nexus was missing from status.json for days while it said "overdue: []".
  // An app the central backup does not list is not protected by it, so it is a red line.
  const listed = new Set(Object.keys(obj(s.apps)));
  for (const { app } of BACKUP_APPS) if (!listed.has(app)) {
    const list = byApp.get(app) ?? [];
    list.push("the central backup does not cover this app (missing from its status file)");
    byApp.set(app, list);
  }
  const dueDay = parisDate(requiredSlot(now));
  if (daysBetween(dueDay, runDay) < 0) {
    for (const { app } of BACKUP_APPS) if (app !== "secval") {
      const list = byApp.get(app) ?? [];
      list.push(`the central backup has not run since ${showDate(runDay)}`);
      byApp.set(app, list);
    }
  }
  return { byApp, note: notes.join(" ") };
}

/** SecVal's own encrypted copies (written by secondCopy.ts). */
export const SECVAL_OWN_RE = /^\d{6}-secval-(code|db)\.(?:zip|dump)\.enc$/;

/**
 * Verifies, at check time, every SecVal own copy inside the counting window: downloads its manifest,
 * checks the signature and that Dropbox's listed size and content_hash equal the signed values.
 * Returns the verified paths (lower case) and one reason per copy that was not counted.
 */
export async function verifySecvalCopies(
  files: FileEntry[],
  f: DropboxFetcher,
  authorization: string,
  env: Env,
  now: Date,
): Promise<{ verified: Set<string>; problems: string[] }> {
  const verified = new Set<string>();
  const problems: string[] = [];
  const key = attestationKey(env);
  const today = parisDate(now);
  for (const file of files) {
    if (!SECVAL_OWN_RE.test(file.name) || !file.path) continue;
    const at = parseCopyName(file.name);
    if (!at || daysBetween(parisDate(at.at), today) > WINDOW_DAYS) continue;
    const manifestPath = file.path.replace(/\.(?:zip|dump)\.enc$/, ".manifest.json");
    let manifest: unknown = null;
    if (key && files.some((x) => (x.path ?? "").toLowerCase() === manifestPath.toLowerCase())) {
      try {
        manifest = await post(f, "https://content.dropboxapi.com/2/files/download",
          { authorization, "Dropbox-API-Arg": JSON.stringify({ path: manifestPath }) });
      } catch (err) {
        problems.push(`SecVal copy ${file.name} not counted: its manifest could not be read (${failReason(err)})`);
        continue;
      }
    }
    const why = verifyCopy(file, manifest, key);
    if (why) problems.push(`SecVal copy ${file.name} not counted: ${why}`);
    else verified.add(file.path.toLowerCase());
  }
  return { verified, problems };
}

/** Works out each app's cell from the files found and the central status file. */
export function judge(
  files: (FileEntry | string)[],
  now: Date,
  central: Map<string, string[]> = new Map(),
  checked: { app: string; needsDb: boolean }[] = BACKUP_APPS,
  verified: ReadonlySet<string> = new Set(),
): Pick<DropboxCheck, "status" | "apps" | "message"> {
  const today = parisDate(now);
  const entries = files
    .map((f) => (typeof f === "string" ? { name: f } : f))
    .filter((f) => f.size === undefined || f.size > 0);
  // SecVal's own copies count only when verified at check time (signed manifest + stored bytes match):
  // fail closed. A manifest file merely existing is not enough. See attestation.ts.
  const found = entries
    .filter((f) => !SECVAL_OWN_RE.test(f.name) || verified.has((f.path ?? "").toLowerCase()))
    .map((f) => parseCopyName(f.name))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const apps = checked.map(({ app, needsDb }): AppCopies => {
    const mine = found.filter((f) => f.app === app);
    const problems: string[] = [];
    const look = (kind: "code" | "db", label: string) => {
      const all = mine.filter((f) => f.kind === kind).sort((a, b) => b.at.getTime() - a.at.getTime());
      // one copy per day: two files of the same day are one copy
      const days = [...new Set(all.map((f) => parisDate(f.at)))];
      const recent = days.filter((d) => {
        const age = daysBetween(d, today);
        return age >= 0 && age <= WINDOW_DAYS;
      }).length;
      const newest = days[0];
      if (!newest) problems.push(`no ${label} copy found at all`);
      else {
        if (recent < MIN_COPIES)
          problems.push(`only ${recent} ${label} cop${recent === 1 ? "y" : "ies"} in the last ${WINDOW_DAYS} days (needs ${MIN_COPIES})`);
        const age = daysBetween(newest, today);
        if (age < 0) problems.push(`newest ${label} copy is future-dated (${showDate(newest)})`);
        else if (daysBetween(parisDate(requiredSlot(now)), newest) < 0)
          problems.push(`newest ${label} copy is from ${showDate(newest)} (${age} days old), older than the last Monday 08:00 Bangkok backup`);
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
  if (res.status < 200 || res.status >= 300) {
    let scope: string | null = null;
    if (res.status === 400 && res.text) scope = scopeFromError(await res.text().catch(() => ""));
    throw new HttpError(res.status, scope);
  }
  return res.json();
}

/** A short-lived access token, from the refresh token (preferred) or a plain access token. */
export async function accessToken(env: Env, f: DropboxFetcher): Promise<string | null> {
  const { DROPBOX_REFRESH_TOKEN: refresh, DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret } = env;
  if (refresh && key && secret) {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: key, client_secret: secret });
    const res = obj(await post(f, "https://api.dropbox.com/oauth2/token", { "content-type": "application/x-www-form-urlencoded" }, body.toString()));
    return str(res.access_token) || null;
  }
  return env.DROPBOX_ACCESS_TOKEN || null;
}

/**
 * Same sign-in, but also returns the scopes Dropbox states for the token (scoped apps list them in the token
 * reply). Used by the second copy's dry run to say, before anything is written, whether the app may write.
 * The token itself is never logged or returned to a page.
 */
export async function accessTokenWithScope(env: Env, f: DropboxFetcher): Promise<{ token: string; scopes: string[] | null } | null> {
  const { DROPBOX_REFRESH_TOKEN: refresh, DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret } = env;
  if (refresh && key && secret) {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: key, client_secret: secret });
    const res = obj(await post(f, "https://api.dropbox.com/oauth2/token", { "content-type": "application/x-www-form-urlencoded" }, body.toString()));
    const token = str(res.access_token);
    if (!token) return null;
    const scope = str(res.scope);
    return { token, scopes: scope ? scope.split(/\s+/).filter(Boolean) : null };
  }
  return env.DROPBOX_ACCESS_TOKEN ? { token: env.DROPBOX_ACCESS_TOKEN, scopes: null } : null;
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
      out.push({
        name: str(e.name),
        size: typeof e.size === "number" ? e.size : undefined,
        path: str(e.path_display),
        contentHash: typeof e.content_hash === "string" ? e.content_hash : undefined,
      });
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
    const failClosed = (problem: string, note: string) => {
      for (const { app } of BACKUP_APPS) central.set(app, [problem]);
      centralNote = note;
    };
    const statusPath = `${folders[0]}/status.json`.toLowerCase();
    const statusFile = files.find((x) => x.name === "status.json" && (x.path ?? "").toLowerCase() === statusPath);
    // The central backup writes its status file in "/backups nov26" (checked 21 Nov 2026); the old
    // "/App backups" folder was deleted on 20 Nov 2026, so there is no other place to look.
    if (!statusFile) {
      failClosed("the central backup status file was not found", `The central backup's status file was not found in ${folders[0]}.`);
    } else {
      try {
        const body = await post(f, "https://content.dropboxapi.com/2/files/download",
          { authorization: headers.authorization, "Dropbox-API-Arg": JSON.stringify({ path: statusFile.path }) });
        const c = centralProblems(body, now);
        central = c.byApp;
        centralNote = c.note;
      } catch (err) {
        failClosed("the central backup status file could not be read",
          "Could not read the central backup's status file: " + failReason(err) + ".");
      }
    }
    if (missingFolders.length) centralNote += ` Folder not found: ${missingFolders.join(", ")}.`;
    const own = await verifySecvalCopies(files, f, headers.authorization, env, now);
    const judged = judge(files, now, central, appsChecked(env), own.verified);
    // Reasons a SecVal copy was not counted are shown, but only turn the cell red if the count is short.
    if (own.problems.length) {
      const sv = judged.apps.find((a) => a.app === "secval");
      if (sv && sv.status !== "ok") {
        sv.problems.push(...own.problems);
        sv.message = sv.problems.join("; ");
      } else centralNote += " " + own.problems.join("; ") + ".";
    }
    return { ...base, centralNote: centralNote.trim(), ...judged };
  } catch (err) {
    return { ...base, status: "error", apps: [], message: "BACKUP CHECK FAILED: could not read Dropbox: " + failReason(err) };
  }
}

// --- cached, and checked once a day -------------------------------------------

const CACHE_MS = 15 * 60_000;
let cache: { at: number; data: DropboxCheck } | null = null;

/** The key kept by "Reconnect Dropbox" (dropboxConnect.ts); used instead of DROPBOX_REFRESH_TOKEN when set. Never logged. */
let storedRefreshToken: string | null = null;
export function setStoredRefreshToken(token: string | null): void {
  storedRefreshToken = token;
}
/** The environment the live check uses: Render's variables, with the reconnected key in front when there is one. */
export function checkEnv(env: Env = process.env): Env {
  return storedRefreshToken ? { ...env, DROPBOX_REFRESH_TOKEN: storedRefreshToken } : env;
}

export async function dropboxStatus(opts: { refresh?: boolean; now?: Date } = {}): Promise<DropboxCheck> {
  const now = opts.now ?? new Date();
  if (cache && !opts.refresh && now.getTime() - cache.at < CACHE_MS) return cache.data;
  const data = await checkDropbox({ now, env: checkEnv() });
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
