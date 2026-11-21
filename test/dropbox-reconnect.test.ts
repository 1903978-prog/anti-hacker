import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.js";
import { openDb } from "../server/db.js";
import { listAudit } from "../server/audit/log.js";
import { accessToken, checkEnv, setStoredRefreshToken } from "../server/backup/dropbox.js";
import { finishReconnect, lastReconnect, loadStoredToken, openToken, sealToken, startReconnect } from "../server/backup/dropboxConnect.js";

const ENV = { DROPBOX_APP_KEY: "appkey", DROPBOX_APP_SECRET: "appsecret-0123456789", DROPBOX_REFRESH_TOKEN: "render-key" };
const NOW = new Date("2026-11-21T07:00:00Z");
const TOKEN = "t".repeat(40);

afterEach(() => setStoredRefreshToken(null));

/** Starts a reconnect and returns the state Dropbox would send back. */
function start(db = openDb(":memory:"), env = ENV, now = NOW) {
  const r = startReconnect(db, "https://secval.onrender.com", env, now);
  if (!r.ok) throw new Error(r.error);
  const url = new URL(r.url);
  return { db, url, state: url.searchParams.get("state")! };
}

const tokenOk = (body: Record<string, unknown>) => {
  const calls: string[] = [];
  const f = async (_url: string, init: { body: string }) => {
    calls.push(init.body);
    return { status: 200, async json() { return body; } };
  };
  return { f, calls };
};

describe("Reconnect Dropbox", () => {
  it("sends the owner to Dropbox's consent page for a lasting key, with a one-time state", () => {
    const { db, url, state } = start();
    expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("appkey");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("https://secval.onrender.com/dropbox/callback");
    expect(state.length).toBeGreaterThanOrEqual(40);
    // Only a hash of the state is kept, never the state itself, and never the app secret.
    const kept = JSON.stringify(db.prepare(`SELECT key, value FROM app_state`).all());
    expect(kept).not.toContain(state);
    expect(kept).not.toContain("appsecret");
  });

  it("cannot start without the app key and secret", () => {
    const r = startReconnect(openDb(":memory:"), "https://x", {}, NOW);
    expect(r.ok).toBe(false);
  });

  it("stores the new key encrypted, uses it for the check, and records only names", async () => {
    const { db, state } = start();
    const { f, calls } = tokenOk({ refresh_token: TOKEN, scope: "account_info.read files.content.read files.metadata.read", access_token: "short" });
    const r = await finishReconnect(db, { code: "the-code", state }, ENV, f, NOW);
    expect(r.ok).toBe(true);
    expect(r.scopes).toContain("files.content.read");
    expect(r.detail).toBe("Dropbox reconnected; the backup check now uses the new key.");
    // The code exchange sends the same redirect address and the app's own key and secret.
    const sent = new URLSearchParams(calls[0]);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("redirect_uri")).toBe("https://secval.onrender.com/dropbox/callback");
    expect(sent.get("client_secret")).toBe(ENV.DROPBOX_APP_SECRET);
    // The live check now prefers the reconnected key over the one in Render.
    expect(checkEnv(ENV).DROPBOX_REFRESH_TOKEN).toBe(TOKEN);
    // Never in clear text in the database, the audit trail or the page's answer.
    const everything = JSON.stringify(db.prepare(`SELECT * FROM app_state`).all()) + JSON.stringify(listAudit(db)) + JSON.stringify(lastReconnect(db));
    expect(everything).not.toContain(TOKEN);
    expect(listAudit(db).some((a) => a.action === "backup.dropbox_reconnect" && a.decision === "allow")).toBe(true);
    // After a restart the stored key is read back with the same app secret.
    setStoredRefreshToken(null);
    expect(loadStoredToken(db, ENV)).toBe(true);
    expect(checkEnv(ENV).DROPBOX_REFRESH_TOKEN).toBe(TOKEN);
  });

  it("says plainly when the new key still lacks the read permission", async () => {
    const { db, state } = start();
    const r = await finishReconnect(db, { code: "c", state }, ENV, tokenOk({ refresh_token: TOKEN, scope: "files.metadata.read" }).f, NOW);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('tick "files.content.read"');
  });

  it("refuses a callback without the matching state, and each state works only once", async () => {
    const { db, state } = start();
    const { f, calls } = tokenOk({ refresh_token: TOKEN });
    expect((await finishReconnect(db, { code: "c", state: "forged" }, ENV, f, NOW)).ok).toBe(false);
    expect((await finishReconnect(db, { code: "c" }, ENV, f, NOW)).ok).toBe(false);
    expect((await finishReconnect(openDb(":memory:"), { code: "c", state }, ENV, f, NOW)).ok).toBe(false);
    // A wrong state does not use up the real one.
    expect((await finishReconnect(db, { code: "c", state }, ENV, f, NOW)).ok).toBe(true);
    expect((await finishReconnect(db, { code: "c", state }, ENV, f, NOW)).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("an anonymous callback with a wrong or no state changes nothing: no audit row, no page message", async () => {
    const { db, state } = start();
    const { f } = tokenOk({ refresh_token: TOKEN, scope: "files.content.read" });
    expect((await finishReconnect(db, { code: "c", state }, ENV, f, NOW)).ok).toBe(true);
    const audit = listAudit(db).length;
    const last = lastReconnect(db);
    for (let i = 0; i < 50; i++) await finishReconnect(db, { code: "c", state: `x${i}` }, ENV, f, NOW);
    await finishReconnect(db, { code: "c", state }, ENV, f, NOW); // replay of the used state
    expect(listAudit(db).length).toBe(audit);
    expect(lastReconnect(db)).toEqual(last);
    expect(checkEnv(ENV).DROPBOX_REFRESH_TOKEN).toBe(TOKEN);
  });

  it("refuses an expired reconnect", async () => {
    const { db, state } = start();
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const r = await finishReconnect(db, { code: "c", state }, ENV, tokenOk({ refresh_token: TOKEN }).f, later);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("expired");
  });

  it("changes nothing when Dropbox says no, fails, or sends no lasting key", async () => {
    for (const [q, f] of [
      [{ error: "access_denied" }, tokenOk({ refresh_token: TOKEN }).f],
      [{ code: "c" }, async () => ({ status: 400, async json() { return { error: "invalid_grant" }; } })],
      [{ code: "c" }, async () => { throw new Error("offline"); }],
      [{ code: "c" }, tokenOk({ access_token: "short-only" }).f],
    ] as const) {
      const { db, state } = start();
      const r = await finishReconnect(db, { ...q, state }, ENV, f as never, NOW);
      expect(r.ok).toBe(false);
      expect(checkEnv(ENV).DROPBOX_REFRESH_TOKEN).toBe("render-key");
      expect(JSON.stringify(db.prepare(`SELECT key FROM app_state`).all())).not.toContain("dropbox.reconnect.token");
    }
  });

  it("falls back to the key in Render when the stored key cannot be opened (app secret changed)", () => {
    const sealed = sealToken(TOKEN, ENV)!;
    expect(openToken(sealed, ENV)).toBe(TOKEN);
    expect(openToken(sealed, { DROPBOX_APP_SECRET: "another-secret" })).toBeNull();
    expect(openToken("not json", ENV)).toBeNull();
    const cut = JSON.parse(sealed);
    expect(openToken(JSON.stringify({ ...cut, tag: cut.tag.slice(0, 8) }), ENV)).toBeNull();
    const db = openDb(":memory:");
    db.prepare(`INSERT INTO app_state (key, value) VALUES ('dropbox.reconnect.token', ?)`).run(sealed);
    expect(loadStoredToken(db, { ...ENV, DROPBOX_APP_SECRET: "another-secret" })).toBe(false);
    expect(checkEnv(ENV).DROPBOX_REFRESH_TOKEN).toBe("render-key");
  });

  it("the sign-in for the check uses the reconnected key", async () => {
    setStoredRefreshToken(TOKEN);
    let sent = "";
    await accessToken(checkEnv(ENV), async (_u, init) => {
      sent = init.body ?? "";
      return { status: 200, async json() { return { access_token: "a" }; } };
    });
    expect(new URLSearchParams(sent).get("refresh_token")).toBe(TOKEN);
  });
});

describe("Reconnect Dropbox routes", () => {
  const API = "api-token-for-tests";
  const make = () => {
    const db = openDb(":memory:");
    const { f } = tokenOk({ refresh_token: TOKEN, scope: "files.content.read" });
    return { db, app: createApp(db, { apiToken: API, dropboxEnv: ENV, dropboxTokenFetch: f }) };
  };

  it("needs a login to start", async () => {
    const { app } = make();
    await request(app).post("/api/backup/dropbox/reconnect").send({}).expect(401);
    const ok = await request(app).post("/api/backup/dropbox/reconnect").set("authorization", `Bearer ${API}`).send({}).expect(200);
    expect(ok.body.url).toMatch(/^https:\/\/www\.dropbox\.com\/oauth2\/authorize\?/);
  });

  it("the public callback only acts on a state from a logged-in start, then returns to the Backup page", async () => {
    const { app, db } = make();
    const bad = await request(app).get("/dropbox/callback?code=c&state=forged").expect(303);
    expect(bad.headers.location).toBe("/?dropbox=failed#backup");
    expect(lastReconnect(db)).toBeNull();
    const started = await request(app).post("/api/backup/dropbox/reconnect").set("authorization", `Bearer ${API}`).send({});
    const state = new URL(started.body.url).searchParams.get("state")!;
    const good = await request(app).get(`/dropbox/callback?code=c&state=${encodeURIComponent(state)}`).expect(303);
    expect(good.headers.location).toBe("/?dropbox=connected#backup");
    expect(lastReconnect(db)?.ok).toBe(true);
  });
});
