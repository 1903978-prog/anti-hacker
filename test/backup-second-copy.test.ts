import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { freshDb } from "./helpers.js";
import { listAudit } from "../server/audit/log.js";
import { appsChecked, judge } from "../server/backup/dropbox.js";
import {
  KEEP, backupKey, copyName, decrypt, dueNow, encrypt, makeZip, readZip, runSecondCopy, secondCopyStatus,
  type BinFetcher, type BinResponse,
} from "../server/backup/secondCopy.js";

const ENV = {
  SECVAL_SECOND_COPY: "on",
  DROPBOX_REFRESH_TOKEN: "r", DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s",
  LITESTREAM_SECRET_ACCESS_KEY: "test-backblaze-secret",
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
    const r = await runSecondCopy(db, { env: { ...ENV, LITESTREAM_SECRET_ACCESS_KEY: undefined }, fetcher: dbx.f, now: NOW });
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
