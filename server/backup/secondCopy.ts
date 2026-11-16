import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";
import { checkStoreCopy } from "./drill.js";
import { accessToken, parisDate, type DropboxFetcher, type Env } from "./dropbox.js";

/**
 * Second backup copy of secval itself (database AND code) in Livio's Dropbox,
 * "/backups nov26/secval". The first copies are Litestream in Backblaze (database)
 * and GitHub (code); this is the second, kept with a different provider, so the
 * release rule "2 database + 2 code copies" can be met without a new credential.
 *
 * Once a day (only when SECVAL_SECOND_COPY=on), on the server:
 *  - database: a consistent snapshot of the live store (SQLite VACUUM INTO), gzip;
 *  - code: a zip of the deployed source tree, with the commit it was built from;
 *  - both encrypted (AES-256-GCM) BEFORE they leave the server; Dropbox then also
 *    encrypts at rest. The key is SECVAL_BACKUP_KEY, or else derived (HKDF) from the
 *    Backblaze secret already set for Litestream; its id is in each manifest;
 *  - uploaded with mode "add" (never overwrites), then downloaded again and
 *    checked: same SHA-256, decrypts, database passes the restore drill's own
 *    integrity check, zip opens with every CRC right and the key files present;
 *  - retention: the newest KEEP copies of each kind are kept; older copies that
 *    THIS job made (exact name pattern) go to Dropbox's "Deleted files" (restorable
 *    for 30 days). Nothing else is ever touched.
 *
 * The result is stored in app_state, shown with the backup status, written to the
 * audit trail, and a failure turns the backup health red. Keys and Dropbox answers
 * are never logged; only status codes are kept.
 */

export const ROOT = "/backups nov26/secval";
export const KEEP = 14;
const STATE_KEY = "backup_second_copy";
const HOUR_MS = 60 * 60_000;
const RETRY_AFTER_MS = 3 * HOUR_MS;
const MAGIC = Buffer.from("SVC1");

export type Kind = "db" | "code";

export interface CopyResult {
  kind: Kind;
  ok: boolean;
  backupId?: string;
  path?: string;
  bytes?: number;
  sha256?: string;
  detail: string;
}

export interface SecondCopyRun {
  ok: boolean;
  at: string;
  /** Paris date of the run, YYYY-MM-DD. */
  day: string;
  detail: string;
  copies: CopyResult[];
  retention: { removed: string[]; detail: string };
}

export function secondCopyMode(env: Env = process.env): "on" | "off" {
  return env.SECVAL_SECOND_COPY === "on" ? "on" : "off";
}

// --- encryption ----------------------------------------------------------------

export function backupKey(env: Env): { key: Buffer; keyId: string; source: string } | null {
  const own = env.SECVAL_BACKUP_KEY;
  let key: Buffer | null = null;
  let source = "";
  if (own && own.length >= 32) {
    key = Buffer.from(hkdfSync("sha256", own, "secval-second-copy", "own-key-v1", 32));
    source = "SECVAL_BACKUP_KEY";
  } else if (env.LITESTREAM_SECRET_ACCESS_KEY) {
    key = Buffer.from(hkdfSync("sha256", env.LITESTREAM_SECRET_ACCESS_KEY, "secval-second-copy", "derived-v1", 32));
    source = "derived from the Backblaze secret (LITESTREAM_SECRET_ACCESS_KEY)";
  }
  if (!key) return null;
  return { key, keyId: createHash("sha256").update(key).digest("hex").slice(0, 12), source };
}

export function encrypt(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

export function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error("not a secval backup file");
  const iv = blob.subarray(4, 16);
  const tag = blob.subarray(blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(16, blob.length - 16)), d.final()]);
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

// --- zip (store of the code) ------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A plain zip (deflate), readable by any unzip tool. */
export function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

/** Reads a zip made by makeZip, checking every entry's CRC. Throws on any damage. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const endAt = zip.length - 22;
  if (endAt < 0 || zip.readUInt32LE(endAt) !== 0x06054b50) throw new Error("zip end record missing");
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("zip directory damaged");
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = zip.readUInt16LE(local + 26);
    const start = local + 30 + lnlen;
    const data = inflateRawSync(zip.subarray(start, start + csize));
    if (crc32(data) !== crc) throw new Error(`zip entry damaged: ${name}`);
    out.set(name, data);
    p += 46 + nlen;
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "data", "bin", "dist", "coverage", ".engineering-tmp"]);
const MAX_FILE = 2 * 1024 * 1024;

/** The deployed source tree (no dependencies, no data, no build tools), plus the commit. */
export function collectCode(dir: string, commit: string): { name: string; data: Buffer }[] {
  const files: { name: string; data: Buffer }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && !e.name.endsWith(".sqlite") && statSync(full).size <= MAX_FILE) {
        files.push({ name: relative(dir, full).split(sep).join("/"), data: readFileSync(full) });
      }
    }
  };
  walk(dir);
  files.push({ name: "SECVAL_COMMIT.txt", data: Buffer.from(`${commit}\n`) });
  return files;
}

// --- Dropbox calls (binary) ---------------------------------------------------------

export interface BinResponse {
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}
export type BinFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body?: string | Buffer },
) => Promise<BinResponse>;

const realBinFetch: BinFetcher = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(120_000) } as RequestInit);

class DbxError extends Error {
  constructor(public status: number, public summary: string) {
    super(`HTTP ${status}`);
  }
}

async function call(f: BinFetcher, url: string, headers: Record<string, string>, body?: string | Buffer): Promise<BinResponse> {
  const res = await f(url, body === undefined ? { method: "POST", headers } : { method: "POST", headers, body });
  if (res.status < 200 || res.status >= 300) {
    let summary = "";
    try {
      const j = (await res.json()) as { error_summary?: unknown };
      summary = typeof j?.error_summary === "string" ? j.error_summary.slice(0, 80) : "";
    } catch {
      /* body not needed */
    }
    throw new DbxError(res.status, summary);
  }
  return res;
}

/** Plain words for a Dropbox failure; never the key or the full body. */
export function plainDropboxFailure(err: unknown): string {
  if (err instanceof DbxError) {
    if (/missing_scope|files\.content\.write/.test(err.summary))
      return 'the Dropbox key may only read: it lacks the "files.content.write" permission';
    if (/conflict/.test(err.summary)) return "a copy with this name already exists (never overwritten)";
    if (/insufficient_space/.test(err.summary)) return "Dropbox is full";
    if (err.status === 401) return "the Dropbox key was refused (HTTP 401)";
    if (err.status === 429) return "Dropbox said too many requests (HTTP 429)";
    return `Dropbox answered HTTP ${err.status}${err.summary ? ` (${err.summary.split("/")[0]})` : ""}`;
  }
  if (err instanceof Error && err.name === "TimeoutError") return "Dropbox did not answer in time";
  return err instanceof Error ? err.message.slice(0, 120) : "could not reach Dropbox";
}

const yymmdd = (day: string) => day.slice(2).replaceAll("-", "");
/** Same style as every other app's copies ("261116-secval-db.dump.enc"), so the Dropbox check counts them. */
export const copyName = (day: string, kind: Kind) => `${yymmdd(day)}-secval-${kind}.${kind === "db" ? "dump" : "zip"}.enc`;
const NAME_RE = /^(\d{6})-secval-(db|code)\.(dump|zip)\.enc$/;
const MANIFEST_RE = /^(\d{6})-secval-(db|code)\.manifest\.json$/;

// --- the run ----------------------------------------------------------------------------

export interface RunOptions {
  env?: Env;
  fetcher?: BinFetcher;
  now?: Date;
  /** Directory of the deployed code (default: current directory). */
  codeDir?: string;
  actor?: string;
}

export async function runSecondCopy(db: DB, opts: RunOptions = {}): Promise<SecondCopyRun> {
  const env = opts.env ?? process.env;
  const f = opts.fetcher ?? realBinFetch;
  const now = opts.now ?? new Date();
  const day = parisDate(now);
  const commit = env.RENDER_GIT_COMMIT || "unknown";
  const base = { at: now.toISOString(), day, copies: [] as CopyResult[], retention: { removed: [] as string[], detail: "not run" } };
  const finish = (r: SecondCopyRun): SecondCopyRun => {
    db.prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(STATE_KEY, JSON.stringify(r));
    appendAudit(db, {
      actor: opts.actor ?? "scheduler",
      action: "backup.second_copy",
      decision: "info",
      detail: { ok: r.ok, detail: r.detail, copies: r.copies.map((c) => ({ kind: c.kind, ok: c.ok, backupId: c.backupId })) },
    });
    return r;
  };

  const k = backupKey(env);
  if (!k) return finish({ ...base, ok: false, detail: "No encryption key: neither SECVAL_BACKUP_KEY nor the Backblaze secret is set, so nothing was copied (never uploaded unencrypted)." });

  let token: string | null;
  try {
    // The read-only check's helper; it only needs the token, so the binary fetcher is fine here.
    token = await accessToken(env, f as unknown as DropboxFetcher);
  } catch (err) {
    return finish({ ...base, ok: false, detail: `Could not sign in to Dropbox: ${plainDropboxFailure(err)}` });
  }
  if (!token) return finish({ ...base, ok: false, detail: "Dropbox is not connected (DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, DROPBOX_APP_SECRET)." });
  const auth = { authorization: `Bearer ${token}` };

  const work = mkdtempSync(join(tmpdir(), "secval-copy-"));
  const copies: CopyResult[] = [];
  try {
    for (const kind of ["db", "code"] as const) {
      let plain: Buffer;
      try {
        if (kind === "db") {
          const snap = join(work, "snapshot.sqlite");
          db.prepare("VACUUM INTO ?").run(snap);
          plain = gzipSync(readFileSync(snap));
        } else {
          plain = makeZip(collectCode(opts.codeDir ?? process.cwd(), commit));
        }
      } catch (err) {
        copies.push({ kind, ok: false, detail: `Could not make the ${kind === "db" ? "database snapshot" : "code archive"}: ${(err as Error).message.slice(0, 120)}` });
        continue;
      }
      const blob = encrypt(plain, k.key);
      const hash = sha256(blob);
      const name = copyName(day, kind);
      const folder = `${ROOT}/${kind === "db" ? "DB" : "CODE"}`;
      const path = `${folder}/${name}`;
      const backupId = `secval-${kind}-${yymmdd(day)}-${hash.slice(0, 12)}`;
      try {
        await call(f, "https://content.dropboxapi.com/2/files/upload",
          { ...auth, "content-type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ path, mode: "add", autorename: false, mute: true }) },
          blob);
        // Restore check: download what Dropbox now holds and prove it is usable.
        const res = await call(f, "https://content.dropboxapi.com/2/files/download",
          { ...auth, "Dropbox-API-Arg": JSON.stringify({ path }) });
        const back = Buffer.from(await res.arrayBuffer());
        if (sha256(back) !== hash) throw new Error("the downloaded copy differs from what was uploaded");
        const opened = decrypt(back, k.key);
        let checked: string;
        if (kind === "db") {
          const file = join(work, "restored.sqlite");
          writeFileSync(file, gunzipSync(opened));
          const c = checkStoreCopy(file);
          if (!c.ok) throw new Error(c.detail);
          checked = `restored and intact (${c.allowlistRows} allowlist rows)`;
        } else {
          const entries = readZip(opened);
          for (const must of ["package.json", "server/index.ts", "SECVAL_COMMIT.txt"])
            if (!entries.has(must)) throw new Error(`code copy is missing ${must}`);
          checked = `opened, ${entries.size} files, every checksum right`;
        }
        const manifest = {
          backupId, app: "secval", kind, createdAt: now.toISOString(), sourceCommit: commit,
          file: path, bytes: blob.length, sha256: hash, plainSha256: sha256(plain),
          format: kind === "db" ? "AES-256-GCM(gzip(SQLite VACUUM INTO))" : "AES-256-GCM(zip of the deployed source)",
          keyId: k.keyId, keySource: k.source, restoreCheck: checked,
          otherCopies: kind === "db" ? "Litestream replica in Backblaze B2 (bucket path secval)" : "GitHub 1903978-prog/anti-hacker",
        };
        await call(f, "https://content.dropboxapi.com/2/files/upload",
          { ...auth, "content-type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ path: `${folder}/${yymmdd(day)}-secval-${kind}.manifest.json`, mode: "add", autorename: false, mute: true }) },
          Buffer.from(JSON.stringify(manifest, null, 2)));
        copies.push({ kind, ok: true, backupId, path, bytes: blob.length, sha256: hash, detail: `Saved and ${checked}` });
      } catch (err) {
        copies.push({ kind, ok: false, backupId, path, detail: `${kind === "db" ? "Database" : "Code"} copy failed: ${err instanceof DbxError ? plainDropboxFailure(err) : (err as Error).message.slice(0, 160)}` });
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const ok = copies.length === 2 && copies.every((c) => c.ok);
  const retention = ok ? await applyRetention(f, auth) : { removed: [], detail: "skipped: today's copies did not both pass, so nothing old is removed" };
  return finish({
    ...base,
    ok,
    copies,
    retention,
    detail: ok ? "Database and code copied to Dropbox, downloaded again and checked" : copies.filter((c) => !c.ok).map((c) => c.detail).join("; "),
  });
}

/** Keeps the newest KEEP copies of each kind; removes only older files this job named. */
async function applyRetention(f: BinFetcher, auth: Record<string, string>): Promise<{ removed: string[]; detail: string }> {
  const removed: string[] = [];
  try {
    for (const sub of ["DB", "CODE"]) {
      const res = await call(f, "https://api.dropboxapi.com/2/files/list_folder",
        { ...auth, "content-type": "application/json" }, JSON.stringify({ path: `${ROOT}/${sub}`, limit: 2000 }));
      const entries = ((await res.json()) as { entries?: { ".tag"?: string; name?: string; path_display?: string }[] }).entries ?? [];
      const ours = entries.filter((e) => e[".tag"] === "file" && typeof e.name === "string" && NAME_RE.test(e.name));
      const days = [...new Set(ours.map((e) => e.name!.slice(0, 6)))].sort().reverse();
      const oldDays = new Set(days.slice(KEEP));
      for (const e of entries) {
        const m = typeof e.name === "string" ? NAME_RE.exec(e.name) ?? MANIFEST_RE.exec(e.name) : null;
        if (!m || e[".tag"] !== "file" || !oldDays.has(m[1]!) || !e.path_display) continue;
        await call(f, "https://api.dropboxapi.com/2/files/delete_v2",
          { ...auth, "content-type": "application/json" }, JSON.stringify({ path: e.path_display }));
        removed.push(e.path_display);
      }
    }
    return { removed, detail: removed.length ? `removed ${removed.length} file(s) older than the newest ${KEEP} days (restorable from Dropbox for 30 days)` : `nothing older than the newest ${KEEP} days` };
  } catch (err) {
    return { removed, detail: `retention could not finish: ${plainDropboxFailure(err)}` };
  }
}

export function getSecondCopy(db: DB): SecondCopyRun | null {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(STATE_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SecondCopyRun;
  } catch {
    return null;
  }
}

/** Status for the backup panel: healthy only when switched on and today's or yesterday's run passed. */
export function secondCopyStatus(db: DB, now: Date = new Date(), env: Env = process.env): {
  mode: "on" | "off"; last: SecondCopyRun | null; healthy: boolean; message: string;
} {
  const mode = secondCopyMode(env);
  const last = getSecondCopy(db);
  const fresh = !!last && now.getTime() - Date.parse(last.at) < 2 * 24 * HOUR_MS;
  const healthy = mode === "on" && fresh && !!last?.ok;
  const message =
    mode === "off" ? "Second copy in Dropbox is switched off (SECVAL_SECOND_COPY is not on)."
      : !last ? "Second copy in Dropbox has not run yet."
      : !last.ok ? `SECOND COPY FAILED: ${last.detail}`
      : !fresh ? "SECOND COPY IS OLD: the last good copy is over two days old."
      : last.detail;
  return { mode, last, healthy, message };
}

/** Whether the scheduler should run now: switched on, no good copy for today, and no failed try in the last 3 hours. */
export function dueNow(last: SecondCopyRun | null, now: Date): boolean {
  if (!last) return true;
  if (last.ok && last.day === parisDate(now)) return false;
  if (!last.ok && now.getTime() - Date.parse(last.at) < RETRY_AFTER_MS) return false;
  return true;
}

/** Runs ~10 minutes after start, then checks hourly. Only when SECVAL_SECOND_COPY=on; never crashes the server. */
export function startSecondCopy(db: DB): void {
  if (secondCopyMode() !== "on") return;
  let running = false;
  const tick = () => {
    if (running || !dueNow(getSecondCopy(db), new Date())) return;
    running = true;
    runSecondCopy(db)
      .catch(() => {
        /* recorded inside; never crash */
      })
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, 10 * 60_000).unref();
  setInterval(tick, HOUR_MS).unref();
}
