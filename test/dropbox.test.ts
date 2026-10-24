import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import {
  checkDropboxBackups,
  lastMonday,
  classifyFile,
  getDropboxHealth,
  rateKind,
  type Fetcher,
} from "../server/backup/dropbox.js";
import { dashboard } from "../server/health/score.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const ENV = { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s", DROPBOX_REFRESH_TOKEN: "r" };
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const monday = (name: string, size: number) => ({ ".tag": "file", name, size, server_modified: "2026-10-19T08:00:00Z" });
const file = (name: string, size: number, h: number) => ({ ".tag": "file", name, size, server_modified: hoursAgo(h) });

/** Fake Dropbox: folder path -> entries; missing path -> 409. Records calls. */
function fake(folders: Record<string, unknown[]>, tokenStatus = 200) {
  const calls: string[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/oauth2/token")) return { status: tokenStatus, json: async () => ({ access_token: "tok" }) };
    const path = (JSON.parse(init.body) as { path: string }).path;
    if (!(path in folders)) return { status: 409, json: async () => ({}) };
    return { status: 200, json: async () => ({ entries: folders[path], has_more: false }) };
  };
  return { f, calls };
}

describe("file classification", () => {
  it("tells database, code and ignorable files apart", () => {
    expect(classifyFile("260923-nexus-db.zip")).toBe("db");
    expect(classifyFile("nexus-db-20261019-1114Z.dump")).toBe("db");
    expect(classifyFile("260923-nexus-code.zip")).toBe("code");
    expect(classifyFile("nexus-history-20261019.bundle")).toBeNull();
    expect(classifyFile("backup-log.txt")).toBeNull();
  });
});

describe("rating one kind of copy", () => {
  it("is healthy under 36 hours, warning to 72, failing beyond or missing", () => {
    const r = (h: number) => rateKind("db", [{ name: "a-db.zip", size: 100, modified: hoursAgo(h) }], [], NOW).rating;
    expect(r(10)).toBe("healthy");
    expect(r(50)).toBe("warning");
    expect(r(100)).toBe("failing");
    expect(rateKind("code", [], [], NOW)).toMatchObject({ rating: "failing", lastUpload: null });
  });
  it("flags an empty or much smaller copy", () => {
    const f = (size: number) => [{ name: "a-db.zip", size, modified: hoursAgo(5) }];
    expect(rateKind("db", f(0), [], NOW).rating).toBe("failing");
    const small = rateKind("db", f(10), [100, 110, 90], NOW);
    expect(small.rating).toBe("warning");
    expect(small.reason).toContain("much smaller");
    expect(rateKind("db", f(95), [100, 110, 90], NOW).rating).toBe("healthy");
  });
});

describe("Monday copy", () => {
  it("finds the last finished Monday", () => {
    expect(lastMonday(new Date("2026-10-24T12:00:00Z"))).toBe("2026-10-19"); // Saturday
    expect(lastMonday(new Date("2026-10-26T09:00:00Z"))).toBe("2026-10-19"); // Monday itself: previous one
    expect(lastMonday(new Date("2026-10-27T09:00:00Z"))).toBe("2026-10-26");
  });
  it("flags a week with no Monday copy even when the copy is fresh", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    const mk = (iso: string) => [{ name: "a-db.zip", size: 100, modified: iso }];
    const missed = rateKind("db", mk("2026-10-24T08:00:00Z"), [], now);
    expect(missed.rating).toBe("warning");
    expect(missed.reason).toContain("Monday 2026-10-19");
    const [a, b] = [mk("2026-10-24T08:00:00Z")[0]!, mk("2026-10-19T08:00:00Z")[0]!];
    expect(rateKind("db", [a, b], [], now).rating).toBe("healthy");
  });
});

describe("Dropbox check", () => {
  it("says not connected, without calling Dropbox, when the settings are missing", async () => {
    const db = freshDb();
    const { f, calls } = fake({});
    await checkDropboxBackups(db, { env: {}, fetcher: f, now: NOW });
    expect(calls).toHaveLength(0);
    const h = getDropboxHealth(db, "nexus-eendigo.fly.dev") ?? getDropboxHealth(db, dashboard(db).find((a) => a.dropbox)!.host);
    expect(h?.rating).toBe("not-connected");
    expect(h?.reason).toContain("DROPBOX_REFRESH_TOKEN");
  });

  it("rates both copies from the folder listing and shows it on the dashboard", async () => {
    const db = freshDb();
    const host = dashboard(db).find((a) => a.host.startsWith("nexus"))!.host;
    const { f, calls } = fake({
      "/nexus/CODE": [file("261024-nexus-code.zip", 20e6, 4), monday("261019-nexus-code.zip", 20e6)],
      "/nexus/DB": [file("261024-nexus-db.zip", 120e6, 4), monday("261019-nexus-db.zip", 120e6)],
    });
    await checkDropboxBackups(db, { env: ENV, fetcher: f, now: NOW });
    const app = dashboard(db).find((a) => a.host === host)!;
    expect(app.dropbox).toMatchObject({ rating: "healthy" });
    expect(app.dropbox!.db.lastUpload).toBe(hoursAgo(4));
    // read-only: token exchange and list calls only
    expect(calls.every((u) => u.endsWith("/oauth2/token") || u.includes("/files/list_folder"))).toBe(true);
    // the credentials never end up in what is stored
    expect(JSON.stringify(app.dropbox)).not.toMatch(/tok|refresh/i);
  });

  it("fails an app whose newest database copy is old, and logs the change once", async () => {
    const db = freshDb();
    const { f } = fake({
      "/nexus/CODE": [file("a-code.zip", 20e6, 3)],
      "/nexus/DB": [file("a-db.zip", 120e6, 200)],
    });
    await checkDropboxBackups(db, { env: ENV, fetcher: f, now: NOW });
    await checkDropboxBackups(db, { env: ENV, fetcher: f, now: NOW });
    const host = dashboard(db).find((a) => a.host.startsWith("nexus"))!.host;
    const h = getDropboxHealth(db, host)!;
    expect(h.rating).toBe("failing");
    expect(h.db.rating).toBe("failing");
    expect(h.code.rating).toBe("healthy");
    const audits = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.dropbox_check' AND target = ?`).get(host) as { n: number };
    expect(audits.n).toBe(1);
  });

  it("explains when the login is refused or the folder is missing", async () => {
    const db = freshDb();
    await checkDropboxBackups(db, { env: ENV, fetcher: fake({}, 400).f, now: NOW });
    const host = dashboard(db).find((a) => a.host.startsWith("nexus"))!.host;
    expect(getDropboxHealth(db, host)!.reason).toContain("refused the saved login");
    await checkDropboxBackups(db, { env: ENV, fetcher: fake({}).f, now: NOW });
    expect(getDropboxHealth(db, host)).toMatchObject({ rating: "failing" });
    expect(getDropboxHealth(db, host)!.reason).toContain("No backup folder");
  });

  it("leaves apps that do not back up to Dropbox without a field", () => {
    const db = freshDb();
    expect(dashboard(db).filter((a) => a.host.startsWith("eendigo.")).every((a) => a.dropbox === null)).toBe(true);
  });
});
