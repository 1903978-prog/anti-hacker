import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb, type DB } from "../server/db.js";
import { createApp } from "../server/app.js";
import { sessionValue, V1_UPGRADE_UNTIL } from "../server/middleware.js";

// 30-day sign-in (P0, 21 Nov 2026): measured from sign-in, survives refresh,
// browser and server restarts and deploys, ends on day 30, on sign-out and on
// a security sign-out. A fake clock stands in for the 30 days.
const TOKEN = "test-token-123";
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-21T09:00:00Z");

function clock(start = T0) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

function app(db: DB, now: () => number, token = TOKEN) {
  return createApp(db, { apiToken: token, now });
}

async function signIn(a: ReturnType<typeof app>): Promise<string> {
  const r = await request(a).post("/api/session").send({ token: TOKEN });
  expect(r.status).toBe(200);
  return (String(r.headers["set-cookie"]).split(";")[0] ?? "");
}

const read = (a: ReturnType<typeof app>, cookie: string) => request(a).get("/api/allowlist").set("Cookie", cookie);

describe("30-day browser sign-in", () => {
  it("sets a 30-day HttpOnly, Secure, SameSite=Strict cookie scoped to /api, without the token", async () => {
    const c = clock();
    const r = await request(app(openDb(":memory:"), c.now)).post("/api/session").send({ token: TOKEN });
    const sc = String(r.headers["set-cookie"]);
    expect(sc).toMatch(/Max-Age=2592000/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Strict/);
    expect(sc).toMatch(/Path=\/api/);
    // host-only: no Domain, so no other app (ATHENA, Nexus, 10bonds, LM) ever sees or clears it
    expect(sc).not.toMatch(/Domain=/i);
    expect(sc).not.toContain(TOKEN);
  });

  it("stays signed in across refreshes, browser restart, server restart and deploy, and on day 29", async () => {
    const c = clock();
    const db = openDb(":memory:");
    const cookie = await signIn(app(db, c.now));
    // refresh / browser restart: the same cookie again
    expect((await read(app(db, c.now), cookie)).status).toBe(200);
    // server restart or deploy: a brand-new process and an empty store
    expect((await read(app(openDb(":memory:"), c.now), cookie)).status).toBe(200);
    c.set(T0 + 29 * DAY);
    const day29 = await read(app(db, c.now), cookie);
    expect(day29.status).toBe(200);
    expect(day29.headers["set-cookie"]).toBeUndefined(); // no silent extension
  });

  it("ends on day 30 and is refused on day 31 with a clear reason, without touching data", async () => {
    const c = clock();
    const db = openDb(":memory:");
    const a = app(db, c.now);
    const cookie = await signIn(a);
    const before = (await request(a).get("/api/allowlist").set("Cookie", cookie)).body.length;
    c.set(T0 + 30 * DAY);
    expect((await read(a, cookie)).status).toBe(401);
    c.set(T0 + 31 * DAY);
    const r = await read(a, cookie);
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe("expired");
    expect(String(r.headers["set-cookie"])).toMatch(/Max-Age=0/);
    // a new sign-in works and the saved data is all still there
    const again = await signIn(a);
    expect((await read(a, again)).body.length).toBe(before);
  });

  it("using the page every day does not stretch the 30 days", async () => {
    const c = clock();
    const db = openDb(":memory:");
    const cookie = await signIn(app(db, c.now));
    for (let d = 1; d < 30; d++) {
      c.set(T0 + d * DAY);
      expect((await read(app(db, c.now), cookie)).status).toBe(200);
    }
    c.set(T0 + 30 * DAY + 1);
    expect((await read(app(db, c.now), cookie)).body.reason).toBe("expired");
  });

  it("sign-out ends the sign-in on the server too: a copied cookie stops working", async () => {
    const c = clock();
    const db = openDb(":memory:");
    const a = app(db, c.now);
    const cookie = await signIn(a);
    const out = await request(a).post("/api/session/end").set("Cookie", cookie).send({});
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
    const r = await read(a, cookie);
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe("signed-out");
    // another browser's sign-in is not affected
    const other = await signIn(a);
    expect((await read(a, other)).status).toBe(200);
  });

  it("security sign-out ends every sign-in at once and is recorded in the audit trail", async () => {
    const c = clock();
    const db = openDb(":memory:");
    const a = app(db, c.now);
    const one = await signIn(a);
    const two = await signIn(a);
    c.set(T0 + 1000);
    const host = "secval.example";
    const r = await request(a).post("/api/session/end-all").set({ Cookie: one, Host: host, Origin: `https://${host}` }).send({});
    expect(r.status).toBe(200);
    expect((await read(a, one)).body.reason).toBe("signed-out");
    expect((await read(a, two)).body.reason).toBe("signed-out");
    const audit = await request(a).get("/api/audit").set("authorization", `Bearer ${TOKEN}`);
    expect(JSON.stringify(audit.body)).toContain("session.revoke_all");
    // signing in afterwards works
    c.set(T0 + 2000);
    expect((await read(a, await signIn(a))).status).toBe(200);
  });

  it("security sign-out needs a signed-in caller", async () => {
    const a = app(openDb(":memory:"), clock().now);
    expect((await request(a).post("/api/session/end-all").send({})).status).toBe(401);
  });

  it("rejects missing, forged, tampered and future-dated cookies", async () => {
    const c = clock();
    const a = app(openDb(":memory:"), c.now);
    const cookie = await signIn(a);
    expect((await request(a).get("/api/allowlist")).body.reason).toBe("not-signed-in");
    expect((await read(a, "secval_session=forged")).status).toBe(401);
    const [name, value] = cookie.split("=");
    const parts = (value ?? "").split(".");
    // push the sign-in time forward to dodge expiry: the signature breaks
    const tampered = [parts[0], (T0 + 365 * DAY).toString(36), parts[2], parts[3]].join(".");
    expect((await read(a, `${name}=${tampered}`)).status).toBe(401);
    expect((await read(a, `${name}=${value}x`)).status).toBe(401);
  });

  it("a changed token (key rotation) ends every sign-in; the new token signs in normally", async () => {
    const c = clock();
    const cookie = await signIn(app(openDb(":memory:"), c.now));
    const rotated = createApp(openDb(":memory:"), { apiToken: "a-brand-new-token-456", now: c.now });
    const r = await read(rotated, cookie);
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe("token-changed");
    const login = await request(rotated).post("/api/session").send({ token: "a-brand-new-token-456" });
    expect((await read(rotated, String(login.headers["set-cookie"]).split(";")[0] ?? "")).status).toBe(200);
  });

  it("keeps protected data private without a valid sign-in", async () => {
    const a = app(openDb(":memory:"), clock().now);
    for (const p of ["/api/allowlist", "/api/audit", "/api/scans", "/api/dashboard"]) {
      expect((await request(a).get(p).set("Cookie", "secval_session=v2.x.y.z")).status).toBe(401);
    }
  });

  it("swaps an old (pre-30-day) cookie once for a 30-day sign-in, so the release signs nobody out", async () => {
    const c = clock();
    const db = openDb(":memory:");
    const a = app(db, c.now);
    const r = await read(a, `secval_session=${sessionValue(TOKEN)}`);
    expect(r.status).toBe(200);
    const fresh = String(r.headers["set-cookie"]);
    expect(fresh).toMatch(/Max-Age=2592000/);
    expect((await read(a, fresh.split(";")[0] ?? "")).status).toBe(200);
    // after the swap date old cookies are refused
    c.set(V1_UPGRADE_UNTIL + 1);
    expect((await read(a, `secval_session=${sessionValue(TOKEN)}`)).status).toBe(401);
  });

  it("an old cookie is not swapped after a security sign-out", async () => {
    const c = clock();
    const db = openDb(":memory:");
    const a = app(db, c.now);
    await request(a).post("/api/session/end-all").set("authorization", `Bearer ${TOKEN}`).send({});
    c.set(T0 + 1000);
    expect((await read(a, `secval_session=${sessionValue(TOKEN)}`)).status).toBe(401);
  });

  it("scripts with the bearer token are unaffected by the clock", async () => {
    const c = clock(T0 + 400 * DAY);
    const a = app(openDb(":memory:"), c.now);
    expect((await request(a).get("/api/allowlist").set("authorization", `Bearer ${TOKEN}`)).status).toBe(200);
  });
});
