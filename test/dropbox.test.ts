import { describe, expect, it } from "vitest";
import { centralProblems, checkDropbox, judge, parseCopyName, showDate, type DropboxFetcher } from "../server/backup/dropbox.js";

const NOW = new Date("2026-11-14T09:00:00Z"); // Saturday 14 Nov 2026

/** Every app with a code and a database copy on each given day (central naming). */
function copies(days: string[], apps = ["compplan", "lm-op-model", "nexus", "10bonds"]) {
  return [
    ...apps.flatMap((a) => days.flatMap((d) => [`${d}-${a}-code.zip.enc`, `${d}-${a}-db.dump.enc`])),
    ...days.map((d) => `${d}-secval-code.zip.enc`),
  ];
}

describe("dropbox backup check", () => {
  it("reads all three naming styles and ignores other files", () => {
    expect(parseCopyName("261112-lm-op-model-db.dump.enc")).toMatchObject({ app: "lm-op-model", kind: "db" });
    expect(parseCopyName("261113-nexus-code.zip")).toMatchObject({ app: "nexus", kind: "code" });
    expect(parseCopyName("compplan-db-20261026-0700Z.dump")).toMatchObject({ app: "compplan", kind: "db" });
    expect(parseCopyName("secval-code-20261102-0700Z.zip")).toMatchObject({ app: "secval", kind: "code" });
    expect(parseCopyName("compplan-history-20261026-0700Z.bundle")).toBeNull();
    expect(parseCopyName("status.json")).toBeNull();
    expect(parseCopyName("261399-nexus-db.zip")).toBeNull();
  });

  it("writes dates the Livio way", () => {
    expect(showDate("2026-11-14")).toBe("14 Nov 2026");
  });

  it("is ok with two recent copies of everything", () => {
    const r = judge(copies(["261113", "261114"]), NOW);
    expect(r.status).toBe("ok");
  });

  it("is red when a folder is empty, naming the app and what is missing", () => {
    const r = judge(copies(["261113", "261114"]).filter((n) => !n.includes("lm-op-model")), NOW);
    expect(r.status).toBe("red");
    const lm = r.apps.find((a) => a.app === "lm-op-model")!;
    expect(lm.problems).toEqual(["no code copy found at all", "no database copy found at all"]);
    expect(r.message).toContain("lm-op-model");
  });

  it("is red with only one copy, even a fresh one", () => {
    const r = judge(copies(["261114"]), NOW);
    expect(r.status).toBe("red");
    expect(r.apps[0]!.problems[0]).toBe("only 1 code copy in the last 8 days (needs 2)");
  });

  it("two files on the same day count as one copy", () => {
    const r = judge([...copies(["261114"]), ...copies(["261114"]).map((n) => n.replace(".enc", ""))], NOW);
    expect(r.status).toBe("red");
  });

  it("is red when the newest copy is stale", () => {
    const r = judge(copies(["261108", "261110"]), NOW);
    expect(r.status).toBe("red");
    expect(r.apps[0]!.problems).toContain("newest code copy is from 10 Nov 2026 (4 days old)");
  });

  it("does not count empty files", () => {
    const files = copies(["261113", "261114"]).map((name) => ({ name, size: name.startsWith("261114-nexus-db") ? 0 : 10 }));
    const r = judge(files, NOW);
    expect(r.apps.find((a) => a.app === "nexus")!.status).toBe("red");
    expect(r.apps.find((a) => a.app === "compplan")!.status).toBe("ok");
  });

  it("secval needs only code copies (its database is checked in Backblaze)", () => {
    const r = judge(copies(["261113", "261114"]), NOW);
    expect(r.apps.find((a) => a.app === "secval")!.recentDb).toBeNull();
  });

  it("turns the central status file's problems into red lines, even when it says nothing is overdue", () => {
    const status = {
      runAt: "2026-11-13T14:07:35.573Z",
      apps: { "lm-op-model": { problem: "Dropbox HTTP 409 path/insufficient_space/", code: { problem: "Dropbox HTTP 409 path/insufficient_space/" } } },
      overdue: [],
    };
    const c = centralProblems(status, NOW);
    expect(c.byApp.get("lm-op-model")).toEqual(["the last code copy failed to save (Dropbox is full)"]);
    const r = judge(copies(["261113", "261114"]), NOW, c.byApp);
    expect(r.status).toBe("red");
    expect(r.apps.find((a) => a.app === "lm-op-model")!.status).toBe("red");
  });

  it("flags a central backup that stopped running", () => {
    const c = centralProblems({ runAt: "2026-11-09T14:00:00Z", apps: {} }, NOW);
    expect(c.byApp.get("nexus")).toEqual(["the central backup has not run since 09 Nov 2026"]);
  });

  it("reproduces 14 Nov 2026: red for every app", () => {
    const files = [
      ...["lm-op-model", "compplan", "10bonds"].flatMap((a) => [
        `261109-${a}-db.dump.enc`, `261111-${a}-db.dump.enc`, `261112-${a}-db.dump.enc`,
        `261111-${a}-code.zip.enc`, `261112-${a}-code.zip.enc`,
      ]),
      "261113-nexus-db.zip", "261112-nexus-code.zip", "261113-nexus-code.zip",
      "secval-code-20261102-0700Z.zip",
    ];
    const status = {
      runAt: "2026-11-13T14:07:35.573Z",
      apps: Object.fromEntries(["lm-op-model", "compplan", "10bonds"].map((a) => [a, { code: { problem: "Dropbox HTTP 409 path/insufficient_space/" } }])),
    };
    const r = judge(files, NOW, centralProblems(status, NOW).byApp);
    expect(r.status).toBe("red");
    expect(r.apps.every((a) => a.status === "red")).toBe(true);
    expect(r.apps.find((a) => a.app === "nexus")!.problems).toEqual(["only 1 database copy in the last 8 days (needs 2)"]);
    expect(r.apps.find((a) => a.app === "secval")!.problems).toEqual([
      "only 0 code copies in the last 8 days (needs 2)",
      "newest code copy is from 02 Nov 2026 (12 days old)",
    ]);
  });

  it("looks only in the one folder Livio chose", async () => {
    const paths: string[] = [];
    const f: DropboxFetcher = async (url, init) => {
      if (url.endsWith("/list_folder")) { paths.push(JSON.parse(init.body ?? "{}").path); return { status: 200, async json() { return { entries: [] }; } }; }
      return { status: 200, async json() { return { access_token: "t" }; } };
    };
    const r = await checkDropbox({ env: { DROPBOX_ACCESS_TOKEN: "t" }, fetcher: f, now: NOW });
    expect(paths).toEqual(["/backups nov26"]);
    expect(r.status).toBe("red");
  });

  it("shows not connected without keys and makes no call", async () => {
    let calls = 0;
    const f: DropboxFetcher = async () => { calls++; return { status: 200, async json() { return {}; } }; };
    const r = await checkDropbox({ env: {}, fetcher: f, now: NOW });
    expect(r.status).toBe("not-connected");
    expect(calls).toBe(0);
  });

  it("names the missing variables, never their values", async () => {
    const r = await checkDropbox({ env: { DROPBOX_APP_KEY: "k", "DROPBOX_REFRESH_TOKEN ": "s3cr3tvalue" }, now: NOW });
    expect(r.message).toContain("Missing or empty: DROPBOX_REFRESH_TOKEN, DROPBOX_APP_SECRET.");
    expect(r.message).not.toContain("s3cr3tvalue");
  });

  it("reads both folders and the status file, follows pages, skips a missing folder", async () => {
    const seen: string[] = [];
    const all = copies(["261113", "261114"]);
    const f: DropboxFetcher = async (url, init) => {
      seen.push(url);
      if (url.endsWith("/oauth2/token")) return { status: 200, async json() { return { access_token: "t" }; } };
      expect(init.headers.authorization).toBe("Bearer t");
      if (url.endsWith("/download")) {
        // Dropbox refuses a text/plain body on content endpoints, so the download must carry none.
        expect(init.body).toBeUndefined();
        return { status: 200, async json() { return { runAt: "2026-11-14T06:00:00Z", apps: {} }; } };
      }
      if (url.endsWith("/list_folder")) {
        const path = JSON.parse(init.body ?? "{}").path;
        if (path === "/old") return { status: 409, async json() { return {}; } };
        return { status: 200, async json() {
          return { entries: [{ ".tag": "file", name: "status.json", path_display: "/backups nov26/status.json", size: 5 }, ...all.slice(0, 4).map((name) => ({ ".tag": "file", name, size: 9 }))], has_more: true, cursor: "c" };
        } };
      }
      return { status: 200, async json() { return { entries: all.slice(4).map((name) => ({ ".tag": "file", name, size: 9 })), has_more: false }; } };
    };
    const env = { DROPBOX_REFRESH_TOKEN: "r", DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s", DROPBOX_BACKUP_FOLDER: "/backups nov26, /old" };
    const r = await checkDropbox({ env, fetcher: f, now: NOW });
    expect(r.status).toBe("ok");
    expect(r.centralNote).toContain("14 Nov 2026");
    expect(r.centralNote).toContain("Folder not found: /old");
    expect(seen.filter((u) => u.endsWith("/list_folder"))).toHaveLength(2);
  });

  it("reports a refused key without leaking it", async () => {
    const f: DropboxFetcher = async () => ({ status: 401, async json() { return { error: "bad token SECRET123" }; } });
    const r = await checkDropbox({ env: { DROPBOX_ACCESS_TOKEN: "SECRET123" }, fetcher: f, now: NOW });
    expect(r.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain("SECRET123");
  });
});
