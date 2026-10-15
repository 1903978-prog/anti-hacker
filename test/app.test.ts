import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";

function app() {
  return createApp(openDb(":memory:"));
}

describe("http api", () => {
  it("reports health", async () => {
    const res = await request(app()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("serves the seeded allowlist", async () => {
    const res = await request(app()).get("/api/allowlist");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
  });

  it("refuses a preflight for an unproven target", async () => {
    const res = await request(app())
      .post("/api/scan/preflight")
      .send({ target: "eendigo.com", mode: "passive" });
    expect(res.status).toBe(403);
    expect(res.body.allowed).toBe(false);
  });

  it("issues a challenge token with placement instructions", async () => {
    const a = app();
    const ch = await request(a).post("/api/allowlist/eendigo.com/challenge").send({});
    expect(ch.status).toBe(200);
    expect(ch.body.token).toMatch(/^secval-/);
    expect(ch.body.instructions["dns-txt"]).toContain("_secval-challenge.eendigo.com");
  });

  it("rejects a challenge for a domain not on the allowlist", async () => {
    const res = await request(app()).post("/api/allowlist/not-listed.example/challenge").send({});
    expect(res.status).toBe(400);
  });

  it("engages and releases the kill switch", async () => {
    const a = app();
    const on = await request(a).post("/api/kill-switch/engage").send({ reason: "test" });
    expect(on.body.killSwitch).toBe("engaged");
    const off = await request(a).post("/api/kill-switch/release").send({});
    expect(off.body.killSwitch).toBe("released");
  });
});
