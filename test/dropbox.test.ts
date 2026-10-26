import { describe, expect, it } from "vitest";
import { checkDropbox, judge, lastMonday, parseCopyName, type DropboxFetcher } from "../server/backup/dropbox.js";

// Tuesday 27 Oct 2026, so last Monday is 26 Oct.
const TUE = new Date("2026-10-27T09:00:00Z");
const MON = new Date("2026-10-26T12:00:00Z");

const full = [
  ...["compplan", "lm-op-model", "nexus", "10bonds"].flatMap((a) => [`${a}-code-20261026-0700Z.zip`, `${a}-db-20261026-0700Z.dump`]),
  "secval-code-20261026-0700Z.zip",
];

describe("dropbox backup check", () => {
  it("reads copy names", () => {
    expect(parseCopyName("lm-op-model-db-20261026-0700Z.dump")?.app).toBe("lm-op-model");
    expect(parseCopyName("compplan-history-20261026-0700Z.bundle")).toBeNull();
    expect(parseCopyName("backup-log.txt")).toBeNull();
  });

  it("does not count today while it is Monday", () => {
    expect(lastMonday(MON)).toBe("2026-10-19");
    expect(lastMonday(TUE)).toBe("2026-10-26");
  });

  it("is ok when every app has last Monday's copies (secval needs no database)", () => {
    const r = judge(full, TUE);
    expect(r.status).toBe("ok");
    expect(r.apps.every((a) => a.status === "ok")).toBe(true);
  });

  it("goes amber and says what is missing", () => {
    const r = judge(full.filter((n) => n !== "nexus-db-20261026-0700Z.dump"), TUE);
    expect(r.status).toBe("amber");
    const nexus = r.apps.find((a) => a.app === "nexus")!;
    expect(nexus.message).toBe("No database copy was made on Monday 2026-10-26");
    expect(r.apps.find((a) => a.app === "compplan")!.status).toBe("ok");
  });

  it("stays amber when only fresh daily copies exist on other days", () => {
    const names = full.map((n) => n.replace("20261026", "20261027"));
    expect(judge(names, TUE).status).toBe("amber");
  });

  it("clears when the next Monday's copies appear", () => {
    const next = full.map((n) => n.replace("20261026", "20261102"));
    expect(judge([...full.filter((n) => n.startsWith("nexus-code")), ...next], new Date("2026-11-03T09:00:00Z")).status).toBe("ok");
  });

  it("counts a copy by its Paris date (Sunday 23:30 UTC is already Monday)", () => {
    const r = judge(["secval-code-20261025-2330Z.zip"], TUE);
    expect(r.apps.find((a) => a.app === "secval")!.status).toBe("ok");
  });

  it("shows not connected without keys and makes no call", async () => {
    let calls = 0;
    const f: DropboxFetcher = async () => { calls++; return { status: 200, async json() { return {}; } }; };
    const r = await checkDropbox({ env: {}, fetcher: f, now: TUE });
    expect(r.status).toBe("not-connected");
    expect(calls).toBe(0);
  });

  it("lists the folder with the refreshed key and follows pages", async () => {
    const seen: string[] = [];
    const f: DropboxFetcher = async (url, init) => {
      seen.push(url);
      if (url.endsWith("/oauth2/token")) return { status: 200, async json() { return { access_token: "t" }; } };
      expect(init.headers.authorization).toBe("Bearer t");
      if (url.endsWith("/list_folder"))
        return { status: 200, async json() { return { entries: full.slice(0, 4).map((name) => ({ name })), has_more: true, cursor: "c" }; } };
      return { status: 200, async json() { return { entries: full.slice(4).map((name) => ({ name })), has_more: false }; } };
    };
    const env = { DROPBOX_REFRESH_TOKEN: "r", DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" };
    const r = await checkDropbox({ env, fetcher: f, now: TUE });
    expect(r.status).toBe("ok");
    expect(seen).toHaveLength(3);
  });

  it("reports a refused key without leaking it", async () => {
    const f: DropboxFetcher = async () => ({ status: 401, async json() { return { error: "bad token SECRET123" }; } });
    const r = await checkDropbox({ env: { DROPBOX_ACCESS_TOKEN: "SECRET123" }, fetcher: f, now: TUE });
    expect(r.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain("SECRET123");
  });
});
