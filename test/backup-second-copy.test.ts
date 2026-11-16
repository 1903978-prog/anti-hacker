import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { freshDb } from "./helpers.js";
import { listAudit } from "../server/audit/log.js";
import { appsChecked, judge } from "../server/backup/dropbox.js";
import {
  CODE_REQUIRED, KEEP, backupKey, collectCode, copyName, decrypt, dueNow, encrypt, makeZip, readZip, refuseReason, runSecondCopy, secondCopyStatus,
  type BinFetcher, type BinResponse,
} from "../server/backup/secondCopy.js";

const ENV = {
  SECVAL_SECOND_COPY: "on",
  DROPBOX_REFRESH_TOKEN: "r", DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s",
  LITESTREAM_SECRET_ACCESS_KEY: "test-backblaze-secret",
  SECVAL_BACKUP_KEY: "test-independent-backup-key-0123456789abcdef",
  RENDER_GIT_COMMIT: "abc123",
};
const NOW = new Date("2026-11-16T09:30:00Z");

/** An in-memory Dropbox: a map of path -> bytes, plus ways to make it misbehave. */
function fakeDropbox(opts: { readOnly?: boolean; tamper?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const calls: string[] = [];
  const reply = (status: number, body: unknown, bytes?: Buffer): BinResponse => ({
    status,
    json: async () => body,
    arrayBuffer: async () => {
      const b = bytes ?? Buffer.alloc(0);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  });
  const f: BinFetcher = async (url, init) => {
    const op = url.split("/").slice(-2).join("/");
    calls.push(op);
    if (url.endsWith("/oauth2/token")) return reply(200, { access_token: "t" });
    const arg = init.headers["Dropbox-API-Arg"] ? JSON.parse(init.headers["Dropbox-API-Arg"]) : JSON.parse(String(init.body));
    if (op === "files/upload") {
      if (opts.readOnly) return reply(401, { error_summary: "missing_scope/.." });
      if (files.has(arg.path)) return reply(409, { error_summary: "path/conflict/file/.." });
      files.set(arg.path, Buffer.from(init.body as Buffer));
      return reply(200, { path_display: arg.path });
    }
    if (op === "files/download") {
      const b = files.get(arg.path);
      if (!b) return reply(409, { error_summary: "path/not_found/" });
      const out = Buffer.from(b);
      if (opts.tamper) out[out.length - 20] = out[out.length - 20]! ^ 0xff;
      return reply(200, {}, out);
    }
    if (op === "files/list_folder") {
      const entries = [...files.keys()]
        .filter((p) => p.startsWith(`${arg.path}/`))
        .map((p) => ({ ".tag": "file", name: p.split("/").pop(), path_display: p }));
      return reply(200, { entries });
    }
    if (op === "files/delete_v2") {
      files.delete(arg.path);
      return reply(200, {});
    }
    return reply(400, {});
  };
  return { f, files, calls };
}

function codeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "secval-code-"));
  mkdirSync(join(d, "server"));
  mkdirSync(join(d, "node_modules"));
  writeFileSync(join(d, "package.json"), '{"name":"secval"}');
  writeFileSync(join(d, "package-lock.json"), "{}");
  writeFileSync(join(d, "tsconfig.json"), "{}");
  writeFileSync(join(d, "render.yaml"), "services: []");
  writeFileSync(join(d, "server", "index.ts"), "console.log('hi')");
  writeFileSync(join(d, "node_modules", "big.js"), "x".repeat(1000));
  return d;
}

describe("secval second copy", () => {
  it("encryption round trip, and a wrong key or damage is refused", () => {
    const k = backupKey(ENV)!;
    const blob = encrypt(Buffer.from("hello"), k.key);
    expect(decrypt(blob, k.key).toString()).toBe("hello");
    expect(blob.includes(Buffer.from("hello"))).toBe(false);
    expect(() => decrypt(blob, backupKey({ SECVAL_BACKUP_KEY: "x".repeat(40) })!.key)).toThrow();
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect(() => decrypt(blob, k.key)).toThrow();
  });

  it("zip round trip checks every entry", () => {
    const zip = makeZip([{ name: "a.txt", data: Buffer.from("aaa") }, { name: "dir/b.txt", data: Buffer.from("b".repeat(500)) }]);
    const back = readZip(zip);
    expect(back.get("dir/b.txt")?.toString()).toBe("b".repeat(500));
    const bad = Buffer.from(zip);
    bad[36] = bad[36]! ^ 0xff; // inside the first entry's compressed data (header 30 + name 5)
    expect(() => readZip(bad)).toThrow();
  });

  it("refuses without an encryption key and never uploads", async () => {
    const db = freshDb();
    const dbx = fakeDropbox();
    const r = await runSecondCopy(db, { env: { ...ENV, SECVAL_BACKUP_KEY: undefined }, fetcher: dbx.f, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/No encryption key/);
    expect(dbx.calls).toEqual([]);
  });

  it("makes, uploads, downloads and checks both copies", async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO allowlist (domain, added_at) VALUES ('example.com', '2026-11-01')`).run();
    const dbx = fakeDropbox();
    const r = await runSecondCopy(db, { env: ENV, fetcher: dbx.f, now: NOW, codeDir: codeDir(), actor: "test" });
    expect(r.detail).toBe("Database and code copied to Dropbox, downloaded again and checked");
    expect(r.ok).toBe(true);
    expect(r.day).toBe("2026-11-16");
    const paths = [...dbx.files.keys()].sort();
    expect(paths).toEqual([
      "/backups nov26/secval/CODE/261116-secval-code.manifest.json",
      "/backups nov26/secval/CODE/261116-secval-code.zip.enc",
      "/backups nov26/secval/DB/261116-secval-db.dump.enc",
      "/backups nov26/secval/DB/261116-secval-db.manifest.json",
    ]);
    // Distinct, identifiable copies.
    const [dbCopy, codeCopy] = r.copies;
    expect(dbCopy!.backupId).toMatch(/^secval-db-261116-[0-9a-f]{12}$/);
    expect(codeCopy!.backupId).toMatch(/^secval-code-261116-[0-9a-f]{12}$/);
    expect(dbCopy!.sha256).not.toBe(codeCopy!.sha256);
    expect(dbCopy!.bytes).toBeGreaterThan(100);
    // The database copy is a real, restorable store holding the row.
    const k = backupKey(ENV)!;
    const dbFile = join(mkdtempSync(join(tmpdir(), "restore-")), "r.sqlite");
    writeFileSync(dbFile, gunzipSync(decrypt(dbx.files.get(dbCopy!.path!)!, k.key)));
    const restored = new Database(dbFile, { readonly: true });
    expect((restored.prepare(`SELECT domain FROM allowlist WHERE domain = 'example.com'`).get() as { domain: string } | undefined)?.domain).toBe("example.com");
    restored.close();
    // The code copy holds the source and the commit, not the dependencies.
    const zip = readZip(decrypt(dbx.files.get(codeCopy!.path!)!, k.key));
    expect(zip.get("SECVAL_COMMIT.txt")?.toString()).toBe("abc123\n");
    expect(zip.has("server/index.ts")).toBe(true);
    expect([...zip.keys()].some((n) => n.startsWith("node_modules"))).toBe(false);
    // The manifest is the attestation.
    const m = JSON.parse(dbx.files.get("/backups nov26/secval/DB/261116-secval-db.manifest.json")!.toString());
    expect(m).toMatchObject({ backupId: dbCopy!.backupId, sha256: dbCopy!.sha256, sourceCommit: "abc123", keyId: k.keyId });
    expect(JSON.stringify(m)).not.toContain("test-backblaze-secret");
    // Recorded, audited and healthy.
    expect(secondCopyStatus(db, NOW, ENV).healthy).toBe(true);
    expect(listAudit(db).some((a) => a.action === "backup.second_copy")).toBe(true);
    expect(dueNow(r, NOW)).toBe(false);
  });

  it("a damaged download fails the run and turns the status red", async () => {
    const db = freshDb();
    const dbx = fakeDropbox({ tamper: true });
    const r = await runSecondCopy(db, { env: ENV, fetcher: dbx.f, now: NOW, codeDir: codeDir() });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/differs from what was uploaded/);
    expect(r.retention.detail).toMatch(/skipped/);
    const s = secondCopyStatus(db, NOW, ENV);
    expect(s.healthy).toBe(false);
    expect(s.message).toMatch(/^SECOND COPY FAILED/);
  });

  it("a read-only Dropbox key is reported in plain words", async () => {
    const db = freshDb();
    const r = await runSecondCopy(db, { env: ENV, fetcher: fakeDropbox({ readOnly: true }).f, now: NOW, codeDir: codeDir() });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/files\.content\.write/);
  });

  it("never overwrites today's copy", async () => {
    const db = freshDb();
    const dbx = fakeDropbox();
    await runSecondCopy(db, { env: ENV, fetcher: dbx.f, now: NOW, codeDir: codeDir() });
    const before = Buffer.from(dbx.files.get("/backups nov26/secval/DB/261116-secval-db.dump.enc")!);
    const r = await runSecondCopy(db, { env: ENV, fetcher: dbx.f, now: NOW, codeDir: codeDir() });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/already exists/);
    expect(dbx.files.get("/backups nov26/secval/DB/261116-secval-db.dump.enc")!.equals(before)).toBe(true);
  });

  it("retention keeps the newest days and removes only its own files", async () => {
    const db = freshDb();
    const dbx = fakeDropbox();
    for (let i = 1; i <= KEEP + 3; i++) {
      const day = new Date(Date.UTC(2026, 9, i, 12)).toISOString().slice(0, 10);
      dbx.files.set(`/backups nov26/secval/DB/${copyName(day, "db")}`, Buffer.from("x"));
    }
    dbx.files.set("/backups nov26/secval/DB/notes-by-livio.txt", Buffer.from("keep me"));
    dbx.files.set("/backups nov26/secval/DB/240101-other-db.dump.enc", Buffer.from("keep me"));
    const r = await runSecondCopy(db, { env: ENV, fetcher: dbx.f, now: NOW, codeDir: codeDir() });
    expect(r.ok).toBe(true);
    const dbFiles = [...dbx.files.keys()].filter((p) => /secval-db\.dump\.enc$/.test(p));
    expect(dbFiles).toHaveLength(KEEP);
    expect(dbFiles.some((p) => p.includes("261116"))).toBe(true);
    expect(dbx.files.has("/backups nov26/secval/DB/notes-by-livio.txt")).toBe(true);
    expect(dbx.files.has("/backups nov26/secval/DB/240101-other-db.dump.enc")).toBe(true);
    expect(r.retention.removed).toHaveLength(4);
  });

  it("off by default; the Dropbox check counts secval only when switched on", () => {
    const db = freshDb();
    expect(secondCopyStatus(db, NOW, {}).mode).toBe("off");
    expect(appsChecked({}).some((a) => a.app === "secval")).toBe(false);
    expect(appsChecked(ENV).some((a) => a.app === "secval")).toBe(true);
    const j = judge(["261116-secval-db.dump.enc", "261115-secval-db.dump.enc", "261116-secval-code.zip.enc", "261115-secval-code.zip.enc"], NOW, new Map(), appsChecked(ENV));
    expect(j.apps.find((a) => a.app === "secval")).toBeTruthy();
  });

  it("retries a failed run only after 3 hours", () => {
    const failed = { ok: false, at: NOW.toISOString(), day: "2026-11-16", detail: "", copies: [], retention: { removed: [], detail: "" } };
    expect(dueNow(failed, new Date(NOW.getTime() + 60 * 60_000))).toBe(false);
    expect(dueNow(failed, new Date(NOW.getTime() + 4 * 60 * 60_000))).toBe(true);
    expect(dueNow(null, NOW)).toBe(true);
  });
});

describe("secval second copy: review #5917832972 hardening", () => {
  it("the code archive takes only allowlisted files and refuses secrets, dotfiles and symlinks", () => {
    const d = codeDir();
    mkdirSync(join(d, "server", "keys"));
    mkdirSync(join(d, "server", ".hidden"));
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".env"), "SECRET=1");
    writeFileSync(join(d, ".env.local"), "SECRET=1");
    writeFileSync(join(d, "server", ".env"), "SECRET=1");
    writeFileSync(join(d, "server", "keys", "x.pem"), "-----BEGIN PRIVATE KEY-----");
    writeFileSync(join(d, "server", "id_rsa"), "key");
    writeFileSync(join(d, "server", "credentials.json"), "{}");
    writeFileSync(join(d, "server", ".hidden", "a.ts"), "x");
    writeFileSync(join(d, "server", "data.sqlite"), "x");
    writeFileSync(join(d, ".git", "config"), "x");
    writeFileSync(join(d, "notes.txt"), "not on the allowlist");
    symlinkSync("/etc/hostname", join(d, "server", "link.ts"));
    const c = collectCode(d, "abc123");
    const names = c.files.map((f) => f.name).sort();
    expect(names).toEqual(["SECVAL_COMMIT.txt", "package-lock.json", "package.json", "render.yaml", "server/index.ts", "tsconfig.json"]);
    const refused = c.refused.map((r) => r.name);
    for (const n of ["server/keys/x.pem", "server/id_rsa", "server/credentials.json", "server/link.ts", "server/.env", "server/.hidden"])
      expect(refused.some((r) => r === n || n.startsWith(r))).toBe(true);
    expect(c.refused.find((r) => r.name === "server/link.ts")?.reason).toMatch(/symlink/);
    for (const n of [".env", ".env.local", "x.pem", "id_rsa", "credentials.json", "a/b.key", "c.sqlite", "d.dump", ".npmrc"])
      expect(refuseReason(n)).not.toBeNull();
    expect(refuseReason("server/index.ts")).toBeNull();
  });

  it("a file over the size cap is refused, not archived", () => {
    const d = codeDir();
    writeFileSync(join(d, "server", "huge.ts"), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
    const c = collectCode(d, "abc123");
    expect(c.files.some((f) => f.name === "server/huge.ts")).toBe(false);
    expect(c.refused.find((r) => r.name === "server/huge.ts")?.reason).toMatch(/large|size|over/i);
  });

  it("the key is independent: the Backblaze secret alone never makes a copy", () => {
    expect(backupKey({ LITESTREAM_SECRET_ACCESS_KEY: "x".repeat(60) })).toBeNull();
    expect(backupKey({ SECVAL_BACKUP_KEY: "short" })).toBeNull();
    const k = backupKey({ SECVAL_BACKUP_KEY: "y".repeat(40) })!;
    expect(k.source).toBe("SECVAL_BACKUP_KEY");
    expect(backupKey({ SECVAL_BACKUP_KEY: "y".repeat(40), LITESTREAM_SECRET_ACCESS_KEY: "other" })!.keyId).toBe(k.keyId);
  });

  it("readZip refuses unsafe names and zip bombs", () => {
    for (const name of ["../x.ts", "/etc/passwd", "a\\b.ts"])
      expect(() => readZip(makeZip([{ name, data: Buffer.from("x") }]))).toThrow();
    const bomb = makeZip([{ name: "a.ts", data: Buffer.alloc(3 * 1024 * 1024, 0) }]);
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => readZip(bomb)).toThrow();
  });

  it("isolated restore: the database and the code come back from Dropbox using only the key", async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO allowlist (domain, added_at) VALUES ('a.example', '2026-11-01'), ('b.example', '2026-11-02')`).run();
    const dir = codeDir();
    const dbx = fakeDropbox();
    const r = await runSecondCopy(db, { env: ENV, fetcher: dbx.f, now: NOW, codeDir: dir });
    expect(r.ok).toBe(true);
    // A fresh reader holds only the downloaded files and SECVAL_BACKUP_KEY.
    const key = backupKey({ SECVAL_BACKUP_KEY: ENV.SECVAL_BACKUP_KEY })!.key;
    const store = join(mkdtempSync(join(tmpdir(), "isolated-")), "restored.sqlite");
    writeFileSync(store, gunzipSync(decrypt(dbx.files.get("/backups nov26/secval/DB/261116-secval-db.dump.enc")!, key)));
    const rdb = new Database(store, { readonly: true });
    expect((rdb.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string }).integrity_check).toBe("ok");
    const tables = rdb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    for (const { name } of tables) {
      const a = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
      const b = (rdb.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
      // The run records itself (audit row, run state) after the snapshot.
      if (name === "audit_log" || name === "app_state") expect(a - b, name).toBeLessThanOrEqual(1);
      else expect(b, name).toBe(a);
    }
    rdb.close();
    const zip = readZip(decrypt(dbx.files.get("/backups nov26/secval/CODE/261116-secval-code.zip.enc")!, key));
    for (const n of CODE_REQUIRED) expect(zip.has(n), n).toBe(true);
    const src = collectCode(dir, "abc123");
    for (const f of src.files) expect(zip.get(f.name)?.equals(f.data), f.name).toBe(true);
    const m = JSON.parse(dbx.files.get("/backups nov26/secval/CODE/261116-secval-code.manifest.json")!.toString());
    expect(m.format).toMatch(/source-only/);
    expect(m.contents.length).toBe(src.files.length);
  });

  it("the Dropbox check counts a SecVal copy only with its same-day manifest", () => {
    const copies = ["261116-secval-db.dump.enc", "261115-secval-db.dump.enc", "261116-secval-code.zip.enc", "261115-secval-code.zip.enc"];
    const manifests = copies.map((n) => n.replace(/\.(zip|dump)\.enc$/, ".manifest.json"));
    const withAll = judge([...copies, ...manifests], NOW, new Map(), appsChecked(ENV)).apps.find((a) => a.app === "secval")!;
    expect(withAll.status).toBe("ok");
    const noManifest = judge([...copies, ...manifests.slice(1)], NOW, new Map(), appsChecked(ENV)).apps.find((a) => a.app === "secval")!;
    expect(noManifest.status).toBe("red");
    expect(noManifest.recentDb).toBe(1);
  });

  it("every git-tracked file in an allowlisted place is in the real archive", () => {
    const root = join(__dirname, "..");
    let tracked: string[];
    try { tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean); }
    catch { return; } // not a git checkout (e.g. an extracted archive)
    const c = collectCode(root, "abc123");
    const have = new Set(c.files.map((f) => f.name));
    expect(c.refused).toEqual([]);
    const dirs = ["server/", "public/", "scripts/", "test/"];
    const root1 = ["package.json", "package-lock.json", "tsconfig.json", "render.yaml", "server/index.ts"];
    for (const n of root1) expect(have.has(n), n).toBe(true);
    const missing = tracked.filter((t) => dirs.some((d) => t.startsWith(d)) && !have.has(t) && refuseReason(t) === null
      && /\.(ts|html|js|css|svg|png|ico|mjs|sh|py)$/.test(t));
    expect(missing).toEqual([]);
  });
});
