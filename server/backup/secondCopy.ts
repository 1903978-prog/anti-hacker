import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";
import { checkStoreCopy } from "./drill.js";
import { accessTokenWithScope, parisDate, type DropboxFetcher, type Env } from "./dropbox.js";

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
  /** True for a dry run: nothing was uploaded or removed. */
  dryRun?: boolean;
  /** Scopes Dropbox stated for the token (null = not stated); missing ones, for the bootstrap check. */
  scopes?: string[] | null;
  missingScopes?: string[] | null;
}

/**
 * off (default): nothing runs. dryrun: the bootstrap step; signs in, reads the token's scopes and the target
 * folder (read-only), builds and encrypts both copies and restores them on the server, but uploads and deletes
 * NOTHING. on: daily copies to Dropbox.
 */
export type Mode = "on" | "dryrun" | "off";
export function secondCopyMode(env: Env = process.env): Mode {
  return env.SECVAL_SECOND_COPY === "on" ? "on" : env.SECVAL_SECOND_COPY === "dryrun" ? "dryrun" : "off";
}

/** The least the Dropbox app needs: list (retention, monitor), read (download check), write (upload, own old copies). */
export const NEEDED_SCOPES = ["files.metadata.read", "files.content.read", "files.content.write"] as const;
export function missingScopes(scopes: string[] | null): string[] | null {
  return scopes === null ? null : NEEDED_SCOPES.filter((s) => !scopes.includes(s));
}

// --- encryption ----------------------------------------------------------------

/**
 * The key is SECVAL_BACKUP_KEY only: its own secret, kept by Livio apart from every other credential, so
 * rotating the Backblaze or Dropbox keys can never make these copies unreadable, and one leaked provider key
 * never opens both copies. No key (or one under 32 characters) means nothing is copied: never unencrypted,
 * never a key derived from another service's secret.
 */
export function backupKey(env: Env): { key: Buffer; keyId: string; source: string } | null {
  const own = env.SECVAL_BACKUP_KEY;
  if (!own || own.length < 32) return null;
  const key = Buffer.from(hkdfSync("sha256", own, "secval-second-copy", "own-key-v1", 32));
  return { key, keyId: createHash("sha256").update(key).digest("hex").slice(0, 12), source: "SECVAL_BACKUP_KEY" };
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
  if (count > MAX_FILES + 1) throw new Error("zip has too many entries");
  let total = 0;
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
    const usize = zip.readUInt32LE(p + 24);
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) throw new Error(`zip entry has an unsafe name: ${name}`);
    total += usize;
    if (usize > MAX_FILE || total > MAX_TOTAL) throw new Error("zip is over its size cap");
    const data = inflateRawSync(zip.subarray(start, start + csize), { maxOutputLength: MAX_FILE });
    if (data.length !== usize) throw new Error(`zip entry has the wrong size: ${name}`);
    if (crc32(data) !== crc) throw new Error(`zip entry damaged: ${name}`);
    out.set(name, data);
    p += 46 + nlen;
  }
  return out;
}

/**
 * Code archive: an explicit, audited ALLOWLIST of the release's source files, never "everything in the folder".
 * Only these root files and these folders (with these file types) are read. Anything hidden (a path part
 * starting with "."), anything that looks like a secret or credential, database files, symlinks and oversized
 * files are refused by design, whatever folder they sit in. It is a SOURCE archive: rebuilding needs
 * `npm ci` (dependencies are not in it) and the server's secrets (never in it).
 */
export const CODE_ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.json", "render.yaml", "litestream.yml", "eslint.config.js", "README.md"];
export const CODE_DIRS: Record<string, string[]> = {
  server: [".ts"],
  public: [".html", ".js", ".css", ".svg", ".png", ".ico"],
  scripts: [".ts", ".mjs", ".js", ".sh", ".py"],
  test: [".ts"],
};
/** Files a restore needs; a code copy missing any of them fails its check. */
export const CODE_REQUIRED = ["package.json", "package-lock.json", "tsconfig.json", "render.yaml", "server/index.ts", "SECVAL_COMMIT.txt"];
const SECRET_NAME = /(^|[._-])(env|secrets?|credentials?|passwords?|tokens?|private|id_rsa|id_ed25519|id_ecdsa|htpasswd|netrc|npmrc|pgpass)([._-]|$)|\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|gpg|asc|sqlite3?|sqlite-wal|sqlite-shm|db|dump|bak|log)$/i;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_FILES = 2000;

/** Why a path is refused, or null when it may go in the archive. Exported for the tests. */
export function refuseReason(rel: string): string | null {
  const parts = rel.split("/");
  if (parts.some((p) => p.startsWith("."))) return "hidden file or folder";
  if (parts.some((p) => SECRET_NAME.test(p))) return "name looks like a secret, credential or data file";
  return null;
}

export interface CodeCollection {
  files: { name: string; data: Buffer }[];
  refused: { name: string; reason: string }[];
  bytes: number;
}

/** Collects the allowlisted source files of the release, plus the commit. Throws when a cap is exceeded. */
export function collectCode(dir: string, commit: string): CodeCollection {
  const files: { name: string; data: Buffer }[] = [];
  const refused: { name: string; reason: string }[] = [];
  let bytes = 0;
  const take = (rel: string) => {
    const why = refuseReason(rel);
    if (why) return void refused.push({ name: rel, reason: why });
    const full = join(dir, ...rel.split("/"));
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return void refused.push({ name: rel, reason: "symlink" });
    if (!st.isFile()) return void refused.push({ name: rel, reason: "not a regular file" });
    if (st.size > MAX_FILE) return void refused.push({ name: rel, reason: "larger than 2 MiB" });
    bytes += st.size;
    if (files.length + 1 > MAX_FILES || bytes > MAX_TOTAL) throw new Error("code archive is over its size cap (2000 files or 32 MiB)");
    files.push({ name: rel, data: readFileSync(full) });
  };
  for (const f of CODE_ROOT_FILES) {
    let st;
    try { st = lstatSync(join(dir, f)); } catch { continue; }
    if (st) take(f);
  }
  const walk = (rel: string, exts: string[]) => {
    const full = join(dir, ...rel.split("/"));
    let st;
    try { st = lstatSync(full); } catch { return; }
    if (st.isSymbolicLink()) return void refused.push({ name: rel, reason: "symlink" });
    if (!st.isDirectory()) return;
    for (const e of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${e.name}`;
      const why = refuseReason(child);
      if (why) { refused.push({ name: child, reason: why }); continue; }
      if (e.isSymbolicLink()) { refused.push({ name: child, reason: "symlink" }); continue; }
      if (e.isDirectory()) { walk(child, exts); continue; }
      if (!exts.some((x) => e.name.endsWith(x))) continue; // not a source type of this folder: simply not part of the release
      take(child);
    }
  };
  for (const [d, exts] of Object.entries(CODE_DIRS)) walk(d, exts);
  files.push({ name: "SECVAL_COMMIT.txt", data: Buffer.from(`${commit}\n`) });
  return { files, refused, bytes };
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
  /** Force a dry run (default: SECVAL_SECOND_COPY=dryrun). */
  dryRun?: boolean;
}

export async function runSecondCopy(db: DB, opts: RunOptions = {}): Promise<SecondCopyRun> {
  const env = opts.env ?? process.env;
  const f = opts.fetcher ?? realBinFetch;
  const now = opts.now ?? new Date();
  const day = parisDate(now);
  const commit = env.RENDER_GIT_COMMIT || "unknown";
  const dry = opts.dryRun ?? secondCopyMode(env) === "dryrun";
  const base = { at: now.toISOString(), day, copies: [] as CopyResult[], retention: { removed: [] as string[], detail: "not run" } };
  const finish = (r: SecondCopyRun): SecondCopyRun => {
    db.prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(STATE_KEY, JSON.stringify(r));
    appendAudit(db, {
      actor: opts.actor ?? "scheduler",
      action: "backup.second_copy",
      decision: "info",
      detail: { ok: r.ok, dryRun: !!r.dryRun, detail: r.detail, copies: r.copies.map((c) => ({ kind: c.kind, ok: c.ok, backupId: c.backupId })) },
    });
    return r;
  };

  const k = backupKey(env);
  if (!k) return finish({ ...base, ok: false, detail: "No encryption key: SECVAL_BACKUP_KEY is not set (or is under 32 characters), so nothing was copied (never uploaded unencrypted)." });

  let signed: { token: string; scopes: string[] | null } | null;
  try {
    // The read-only check's helper; it only needs the token, so the binary fetcher is fine here.
    signed = await accessTokenWithScope(env, f as unknown as DropboxFetcher);
  } catch (err) {
    return finish({ ...base, dryRun: dry, ok: false, detail: `Could not sign in to Dropbox: ${plainDropboxFailure(err)}` });
  }
  if (!signed) return finish({ ...base, dryRun: dry, ok: false, detail: "Dropbox is not connected (DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, DROPBOX_APP_SECRET)." });
  const auth = { authorization: `Bearer ${signed.token}` };
  const scopeInfo = { scopes: signed.scopes, missingScopes: missingScopes(signed.scopes) };

  if (dry) {
    // Read-only: the parent folder must be reachable. Nothing is created, uploaded or removed.
    let reach: string;
    try {
      await call(f, "https://api.dropboxapi.com/2/files/list_folder",
        { ...auth, "content-type": "application/json" }, JSON.stringify({ path: ROOT.slice(0, ROOT.lastIndexOf("/")), limit: 1 }));
      reach = `${ROOT.slice(0, ROOT.lastIndexOf("/"))} is readable`;
    } catch (err) {
      reach = `the backup folder could not be read: ${err instanceof DbxError ? plainDropboxFailure(err) : (err as Error).message.slice(0, 120)}`;
    }
    const work = mkdtempSync(join(tmpdir(), "secval-dry-"));
    const copies: CopyResult[] = [];
    try {
      for (const kind of ["db", "code"] as const) {
        try {
          const { plain, code } = makePlain(db, kind, work, opts.codeDir ?? process.cwd(), commit);
          const blob = encrypt(plain, k.key);
          const checked = checkCopy(kind, decrypt(blob, k.key), work, commit);
          copies.push({ kind, ok: true, bytes: blob.length, sha256: sha256(blob), detail: `Dry run: built, encrypted and ${checked}${code ? `; ${code.refused.length} files refused by the allowlist` : ""}` });
        } catch (err) {
          copies.push({ kind, ok: false, detail: `Dry run ${kind} failed: ${(err as Error).message.slice(0, 160)}` });
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    const miss = scopeInfo.missingScopes;
    const scopeNote = miss === null ? "Dropbox did not state the token's scopes, so write permission is proven only by the first real run"
      : miss.length ? `the Dropbox app lacks ${miss.join(", ")}` : "the Dropbox app has every needed scope";
    const ok = copies.every((c) => c.ok) && !reach.startsWith("the backup folder could not") && !(miss && miss.length);
    return finish({
      ...base, ...scopeInfo, dryRun: true, ok, copies,
      retention: { removed: [], detail: "dry run: nothing removed" },
      detail: `DRY RUN, nothing uploaded or removed. ${copies.map((c) => c.detail).join("; ")}. ${reach}; ${scopeNote}.`,
    });
  }

  const work = mkdtempSync(join(tmpdir(), "secval-copy-"));
  const copies: CopyResult[] = [];
  try {
    for (const kind of ["db", "code"] as const) {
      let plain: Buffer;
      let code: CodeCollection | null = null;
      try {
        ({ plain, code } = makePlain(db, kind, work, opts.codeDir ?? process.cwd(), commit));
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
        const checked = checkCopy(kind, decrypt(back, k.key), work, commit);
        const manifest = {
          backupId, app: "secval", kind, createdAt: now.toISOString(), sourceCommit: commit,
          file: path, bytes: blob.length, sha256: hash, plainSha256: sha256(plain),
          format: kind === "db" ? "AES-256-GCM(gzip(SQLite VACUUM INTO))" : "AES-256-GCM(zip of the allowlisted release source; source-only, rebuild needs npm ci and the server secrets)",
          ...(code ? { contents: code.files.map((x) => ({ name: x.name, sha256: sha256(x.data) })), refusedCount: code.refused.length } : {}),
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
  Object.assign(base, scopeInfo);
  const retention = ok ? await applyRetention(f, auth) : { removed: [], detail: "skipped: today's copies did not both pass, so nothing old is removed" };
  return finish({
    ...base,
    ok,
    copies,
    retention,
    detail: ok ? "Database and code copied to Dropbox, downloaded again and checked" : copies.filter((c) => !c.ok).map((c) => c.detail).join("; "),
  });
}

/** The plain (unencrypted) bytes of one copy: a VACUUM INTO snapshot, gzipped, or the allowlisted code zip. */
function makePlain(db: DB, kind: Kind, work: string, codeDir: string, commit: string): { plain: Buffer; code: CodeCollection | null } {
  if (kind === "db") {
    const snap = join(work, `snapshot-${randomBytes(4).toString("hex")}.sqlite`);
    db.prepare("VACUUM INTO ?").run(snap);
    return { plain: gzipSync(readFileSync(snap)), code: null };
  }
  const code = collectCode(codeDir, commit);
  return { plain: makeZip(code.files), code };
}

/** Restore check on decrypted bytes; throws with a plain reason. Same check for the dry run and the real run. */
function checkCopy(kind: Kind, opened: Buffer, work: string, commit: string): string {
  if (kind === "db") {
    const file = join(work, `restored-${randomBytes(4).toString("hex")}.sqlite`);
    writeFileSync(file, gunzipSync(opened));
    const c = checkStoreCopy(file);
    if (!c.ok) throw new Error(c.detail);
    return `restored and intact (${c.allowlistRows} allowlist rows)`;
  }
  const entries = readZip(opened);
  for (const must of CODE_REQUIRED) if (!entries.has(must)) throw new Error(`code copy is missing ${must}`);
  for (const name of entries.keys())
    if (name !== "SECVAL_COMMIT.txt" && refuseReason(name)) throw new Error(`code copy holds a refused file: ${name}`);
  if (entries.get("SECVAL_COMMIT.txt")!.toString().trim() !== commit) throw new Error("code copy names a different commit");
  return `opened, ${entries.size} files, every checksum right, no secret-looking file`;
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
  mode: Mode; last: SecondCopyRun | null; healthy: boolean; message: string;
} {
  const mode = secondCopyMode(env);
  const last = getSecondCopy(db);
  const fresh = !!last && now.getTime() - Date.parse(last.at) < 2 * 24 * HOUR_MS;
  const healthy = mode === "on" && fresh && !!last?.ok;
  const message =
    mode === "off" ? "Second copy in Dropbox is switched off (SECVAL_SECOND_COPY is not on)."
      : mode === "dryrun" ? `Second copy is in DRY RUN (nothing written to Dropbox). ${last ? last.detail : "Not run yet."}`
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
  if (secondCopyMode() === "off") return;
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
