import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";
import { dashboardHosts } from "../health/report.js";
import { appFor } from "../usage/providers.js";

/**
 * Dropbox backup health: for each app, are there healthy, recent copies of
 * its database and its code in Dropbox, and when was the last upload?
 *
 * Read-only: the only Dropbox calls are the sign-in token exchange and
 * "list folder". File CONTENTS are never downloaded; only names, sizes and
 * upload times are looked at, and only those facts are stored. The login
 * values (DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN) are the
 * ones the apps already use for their backups; they are read from the
 * environment, never stored, logged or shown, and provider error bodies are
 * not passed on. This reads Livio's own account, so it is not scanning and
 * does not go through the scan policy engine.
 */

export type BackupRating = "healthy" | "warning" | "failing" | "not-connected";
export type CopyKind = "db" | "code";

export interface KindHealth {
  kind: CopyKind;
  rating: BackupRating;
  /** When the newest copy was uploaded to Dropbox (ISO), if any. */
  lastUpload: string | null;
  sizeBytes: number | null;
  /** Plain-language reason for the rating. */
  reason: string;
}

export interface DropboxHealth {
  /** The worse of the database and code ratings. */
  rating: BackupRating;
  checkedAt: string;
  reason: string;
  db: KindHealth;
  code: KindHealth;
}

/** Apps that back up to Dropbox, and the folder name each uses. */
export const BACKUP_APPS = ["compplan", "lm-op-model", "nexus", "10bonds", "secval"] as const;

export const HEALTHY_HOURS = 36; // a daily backup, plus slack
export const WARNING_HOURS = 72;
/** A copy below this share of the usual size is flagged. */
export const SHRINK_RATIO = 0.5;

const HOUR = 3_600_000;

export type Fetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const realFetch: Fetcher = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

type Env = Record<string, string | undefined>;

interface DropboxFile {
  name: string;
  size: number;
  modified: string;
}

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/** Which backup app (if any) a dashboard host is. */
export function backupAppFor(host: string): string | null {
  const key = appFor(host.split(".")[0]!);
  const dir = key === "nexus" ? "nexus" : key;
  return (BACKUP_APPS as readonly string[]).includes(dir) ? dir : null;
}

/** Folders to look in for one app. DROPBOX_BACKUP_FOLDERS (JSON {"app": ["/path", ...]}) overrides. */
export function foldersFor(app: string, env: Env): string[] {
  try {
    const custom = JSON.parse(env.DROPBOX_BACKUP_FOLDERS ?? "{}") as Record<string, unknown>;
    const mine = custom[app];
    if (Array.isArray(mine) && mine.every((p) => typeof p === "string")) return mine as string[];
  } catch {
    /* ignore a malformed override */
  }
  return [`/${app}/CODE`, `/${app}/DB`, `/App backups/${app}`];
}

/** database copy, code copy, or neither (history bundles and other files are ignored). */
export function classifyFile(name: string): CopyKind | null {
  const n = name.toLowerCase();
  if (/history|\.bundle$|\.log$|\.txt$/.test(n)) return null;
  if (/(^|[-_])db([-_.]|$)|\.dump$|\.sql(\.|$)/.test(n)) return "db";
  if (/code|\.zip$|\.tar/.test(n)) return "code";
  return null;
}

async function post(f: Fetcher, url: string, headers: Record<string, string>, body: string): Promise<unknown> {
  const res = await f(url, { method: "POST", headers, body });
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status);
  return res.json();
}

async function accessToken(env: Env, f: Fetcher): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.DROPBOX_REFRESH_TOKEN!,
    client_id: env.DROPBOX_APP_KEY!,
    client_secret: env.DROPBOX_APP_SECRET!,
  }).toString();
  const out = (await post(f, "https://api.dropboxapi.com/oauth2/token", { "content-type": "application/x-www-form-urlencoded" }, body)) as {
    access_token?: unknown;
  };
  if (typeof out?.access_token !== "string") throw new HttpError(500);
  return out.access_token;
}

/** Files in one folder (not subfolders); null when the folder does not exist. */
async function listFolder(f: Fetcher, token: string, path: string): Promise<DropboxFile[] | null> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const files: DropboxFile[] = [];
  let url = "https://api.dropboxapi.com/2/files/list_folder";
  let body = JSON.stringify({ path, recursive: false, limit: 200 });
  for (let page = 0; page < 5; page++) {
    let out: Record<string, unknown>;
    try {
      out = (await post(f, url, headers, body)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return null; // folder not found / no access
      throw err;
    }
    for (const e of (Array.isArray(out.entries) ? out.entries : []) as Array<Record<string, unknown>>) {
      if (e[".tag"] !== "file" || typeof e.name !== "string") continue;
      const modified = typeof e.server_modified === "string" ? e.server_modified : typeof e.client_modified === "string" ? e.client_modified : "";
      files.push({ name: e.name, size: typeof e.size === "number" ? e.size : 0, modified });
    }
    if (out.has_more !== true || typeof out.cursor !== "string") break;
    url = "https://api.dropboxapi.com/2/files/list_folder/continue";
    body = JSON.stringify({ cursor: out.cursor });
  }
  return files;
}

function failReason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 400 || err.status === 401) return `Dropbox refused the saved login (HTTP ${err.status}); the three Dropbox settings may be wrong or expired`;
    if (err.status === 429) return "Dropbox said too many requests (HTTP 429); will try again later";
    return `Dropbox answered HTTP ${err.status}`;
  }
  if (err instanceof Error && err.name === "TimeoutError") return "Dropbox did not answer in time";
  return "could not reach Dropbox";
}

const worse = (a: BackupRating, b: BackupRating): BackupRating => {
  const order: BackupRating[] = ["healthy", "warning", "failing", "not-connected"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))]!;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

const TZ = "Europe/Paris";
const parisDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
const parisWeekday = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);

/** The most recent Monday that has already ended (today does not count), as a Paris date YYYY-MM-DD. */
export function lastMonday(now: Date): string {
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parisWeekday(now));
  const days = back === 0 ? 7 : back;
  const t = new Date(now.getTime() - days * 24 * HOUR);
  return parisDay(t);
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const kindName = (k: CopyKind) => (k === "db" ? "database" : "code");

/** Rates one kind of copy from the files found and the sizes seen before. */
export function rateKind(kind: CopyKind, files: DropboxFile[], earlierSizes: number[], now: Date): KindHealth {
  const mine = files.filter((x) => classifyFile(x.name) === kind && x.modified);
  if (!mine.length) {
    return { kind, rating: "failing", lastUpload: null, sizeBytes: null, reason: `No ${kindName(kind)} copy found in Dropbox.` };
  }
  const newest = mine.reduce((a, b) => (Date.parse(b.modified) > Date.parse(a.modified) ? b : a));
  const hours = (now.getTime() - Date.parse(newest.modified)) / HOUR;
  const ageText = hours < 48 ? `${Math.max(0, Math.round(hours))} hours old` : `${Math.round(hours / 24)} days old`;
  let rating: BackupRating = hours <= HEALTHY_HOURS ? "healthy" : hours <= WARNING_HOURS ? "warning" : "failing";
  let reason =
    rating === "healthy"
      ? `Newest ${kindName(kind)} copy is ${ageText}.`
      : `Newest ${kindName(kind)} copy is ${ageText} (a daily backup should be under ${HEALTHY_HOURS} hours).`;
  if (newest.size <= 0) {
    rating = "failing";
    reason = `Newest ${kindName(kind)} copy is empty (0 bytes).`;
  } else {
    const usual = median(earlierSizes);
    if (usual > 0 && newest.size < usual * SHRINK_RATIO) {
      rating = worse(rating, "warning");
      reason += ` It is ${mb(newest.size)}, much smaller than the usual ${mb(usual)}.`;
    }
  }
  // Livio's rule: a copy must be made every Monday.
  const monday = lastMonday(now);
  if (!mine.some((x) => parisDay(new Date(x.modified)) === monday)) {
    rating = worse(rating, "warning");
    reason += ` No ${kindName(kind)} copy was made on Monday ${monday}.`;
  }
  return { kind, rating, lastUpload: new Date(newest.modified).toISOString(), sizeBytes: newest.size, reason };
}

/** Remembers file names and sizes seen (facts only), and returns earlier sizes of the same kind. */
function recordAndRecall(db: DB, app: string, kind: CopyKind, files: DropboxFile[]): number[] {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO dropbox_backup_files (app, kind, name, size, uploaded_at, first_seen) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const mine = files.filter((x) => classifyFile(x.name) === kind && x.modified);
  const newest = mine.reduce<DropboxFile | null>((a, b) => (!a || Date.parse(b.modified) > Date.parse(a.modified) ? b : a), null);
  for (const x of mine) ins.run(app, kind, x.name, x.size, x.modified, now);
  const rows = db
    .prepare(
      `SELECT size FROM dropbox_backup_files WHERE app = ? AND kind = ? AND name <> ? AND size > 0
       ORDER BY uploaded_at DESC LIMIT 10`,
    )
    .all(app, kind, newest?.name ?? "") as Array<{ size: number }>;
  return rows.map((r) => r.size);
}

export function getDropboxHealth(db: DB, host: string): DropboxHealth | null {
  const row = db.prepare(`SELECT result FROM dropbox_backup_status WHERE host = ?`).get(host) as { result: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.result) as DropboxHealth;
  } catch {
    return null;
  }
}

function save(db: DB, host: string, app: string, h: DropboxHealth, actor: string): void {
  const before = getDropboxHealth(db, host);
  db.prepare(
    `INSERT INTO dropbox_backup_status (host, app, checked_at, result) VALUES (?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET app = excluded.app, checked_at = excluded.checked_at, result = excluded.result`,
  ).run(host, app, h.checkedAt, JSON.stringify(h));
  if (before?.rating !== h.rating) {
    appendAudit(db, {
      actor,
      action: "backup.dropbox_check",
      target: host,
      decision: "info",
      detail: { from: before?.rating ?? null, to: h.rating, db: h.db.lastUpload, code: h.code.lastUpload },
    });
  }
}

function notConnected(kind: CopyKind, reason: string): KindHealth {
  return { kind, rating: "not-connected", lastUpload: null, sizeBytes: null, reason };
}

/** Checks every app that backs up to Dropbox and stores the result. */
export async function checkDropboxBackups(
  db: DB,
  opts: { env?: Env; fetcher?: Fetcher; now?: Date; actor?: string } = {},
): Promise<DropboxHealth[]> {
  const env = opts.env ?? process.env;
  const f = opts.fetcher ?? realFetch;
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "dropbox-check";
  const checkedAt = now.toISOString();

  const targets = dashboardHosts(db)
    .map((h) => ({ host: h.host, app: backupAppFor(h.host) }))
    .filter((t): t is { host: string; app: string } => !!t.app);
  const out: DropboxHealth[] = [];

  const put = (t: { host: string; app: string }, d: KindHealth, c: KindHealth, reason?: string) => {
    const rating = worse(d.rating, c.rating);
    const h: DropboxHealth = { rating, checkedAt, reason: reason ?? [d.reason, c.reason].join(" "), db: d, code: c };
    save(db, t.host, t.app, h, actor);
    out.push(h);
  };

  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET || !env.DROPBOX_REFRESH_TOKEN) {
    const why = "Not connected yet. Needs the three Dropbox settings (DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN) on Render.";
    for (const t of targets) put(t, notConnected("db", why), notConnected("code", why), why);
    return out;
  }

  let token: string;
  try {
    token = await accessToken(env, f);
  } catch (err) {
    const why = "Could not sign in to Dropbox: " + failReason(err);
    for (const t of targets) put(t, notConnected("db", why), notConnected("code", why), why);
    return out;
  }

  for (const t of targets) {
    try {
      const files: DropboxFile[] = [];
      let found = 0;
      for (const folder of foldersFor(t.app, env)) {
        const list = await listFolder(f, token, folder);
        if (list) {
          found++;
          files.push(...list);
        }
      }
      if (!found) {
        const why = `No backup folder for ${t.app} was found in Dropbox.`;
        put(t, { kind: "db", rating: "failing", lastUpload: null, sizeBytes: null, reason: why },
          { kind: "code", rating: "failing", lastUpload: null, sizeBytes: null, reason: why }, why);
        continue;
      }
      const dbH = rateKind("db", files, recordAndRecall(db, t.app, "db", files), now);
      const codeH = rateKind("code", files, recordAndRecall(db, t.app, "code", files), now);
      put(t, dbH, codeH);
    } catch (err) {
      const why = "Could not read the Dropbox folders: " + failReason(err);
      put(t, notConnected("db", why), notConnected("code", why), why);
    }
  }
  return out;
}

/** Checks a minute after start, then daily. A failed round never crashes the server. */
export function startDropboxChecker(db: DB): () => void {
  const run = () => void checkDropboxBackups(db, { actor: "scheduler" }).catch(() => {
    /* recorded as a result; never crash */
  });
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 24 * HOUR);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
