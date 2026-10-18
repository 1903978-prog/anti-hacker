import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";

const TOKEN = "test-token-123";
const auth = { authorization: `Bearer ${TOKEN}` };

function app() {
  return createApp(openDb(":memory:"), { apiToken: TOKEN });
}

describe("http api", () => {
  it("reports health", async () => {
    const res = await request(app()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("serves the seeded allowlist with the token", async () => {
    const res = await request(app()).get("/api/allowlist").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("keeps every read page private without the token", async () => {
    const a = app();
    for (const path of ["/api/allowlist", "/api/audit", "/api/scans", "/api/dashboard", "/api/schedule"]) {
      expect((await request(a).get(path)).status).toBe(401);
      expect((await request(a).get(path).set({ authorization: "Bearer wrong" })).status).toBe(401);
    }
    // the public liveness check stays open for the uptime pinger
    expect((await request(a).get("/health")).status).toBe(200);
  });

  it("refuses a preflight for an unproven target", async () => {
    const res = await request(app())
      .post("/api/scan/preflight")
      .set(auth)
      .send({ target: "eendigo.com", mode: "passive" });
    expect(res.status).toBe(403);
    expect(res.body.allowed).toBe(false);
  });

  it("issues a challenge token with placement instructions", async () => {
    const a = app();
    const ch = await request(a).post("/api/allowlist/eendigo.com/challenge").set(auth).send({});
    expect(ch.status).toBe(200);
    expect(ch.body.token).toMatch(/^secval-/);
    expect(ch.body.instructions["dns-txt"]).toContain("_secval-challenge.eendigo.com");
  });

  it("rejects a challenge for a domain not on the allowlist", async () => {
    const res = await request(app()).post("/api/allowlist/not-listed.example/challenge").set(auth).send({});
    expect(res.status).toBe(400);
  });

  it("engages and releases the kill switch", async () => {
    const a = app();
    const on = await request(a).post("/api/kill-switch/engage").set(auth).send({ reason: "test" });
    expect(on.body.killSwitch).toBe("engaged");
    const off = await request(a).post("/api/kill-switch/release").set(auth).send({});
    expect(off.body.killSwitch).toBe("released");
  });
});

describe("control-plane hardening", () => {
  it("sets security headers on responses", async () => {
    const res = await request(app()).get("/health");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects a state-changing request without a token", async () => {
    const res = await request(app()).post("/api/kill-switch/engage").send({});
    expect(res.status).toBe(401);
  });

  it("rejects a state-changing request with a wrong token", async () => {
    const res = await request(app())
      .post("/api/kill-switch/engage")
      .set({ authorization: "Bearer wrong" })
      .send({});
    expect(res.status).toBe(401);
  });

  it("fails closed when no token is configured", async () => {
    const noToken = createApp(openDb(":memory:"), { apiToken: undefined });
    const res = await request(noToken).post("/api/kill-switch/engage").send({});
    expect(res.status).toBe(503);
    // reads are refused too
    expect((await request(noToken).get("/api/allowlist")).status).toBe(503);
  });
});
