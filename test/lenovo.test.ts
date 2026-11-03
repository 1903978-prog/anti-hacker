import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { checkApp, lenovoForHost, lenovoOverview, refreshPassive, resetLenovoCache, type LenovoFetch } from "../server/lenovo/check.js";

const ENV = {
  OLLAMA_BASE_URL: "https://lenovo.example.com/",
  OLLAMA_CF_ACCESS_CLIENT_ID: "id-abc",
  OLLAMA_CF_ACCESS_CLIENT_SECRET: "super-secret-xyz",
};

function fake(over: { open?: number; pull?: number; chatStatus?: number } = {}): LenovoFetch {
  return async (url, init) => {
    const authed = Boolean(init.headers["CF-Access-Client-Id"]);
    const path = new URL(url).pathname;
    const ok = (status: number, body: string) => ({ status, text: async () => body });
    if (path === "/api/version") return authed ? ok(200, '{"version":"0.12"}') : over.open === 200 ? ok(200, '{"version":"0.12"}') : ok(403, "login");
    if (path === "/api/chat") return ok(over.chatStatus ?? 200, '{"message":{"content":"OK"}}');
    if (path === "/api/pull") return ok(over.pull ?? 403, "{}");
    return ok(404, "");
  };
}

beforeEach(() => resetLenovoCache());

describe("lenovo check", () => {
  it("apps that do not use the Lenovo are 'not connected', never a failure", async () => {
    for (const app of ["10bonds", "eendigo", "secval"]) {
      const r = await checkApp(app, {}, { fetch: async () => { throw new Error("must not call"); } });
      expect(r.status).toBe("not-connected");
    }
  });

  it("connected app with everything right is ok", async () => {
    const r = await checkApp("compplan", ENV, { fetch: fake() });
    expect(r.status).toBe("ok");
    expect(r.checks.map((c) => c.id)).toEqual(["env", "version", "closed", "chat", "pull"]);
    expect(JSON.stringify(r)).not.toContain("super-secret-xyz");
  });

  it("alerts on missing variables and makes no network call", async () => {
    const r = await checkApp("compplan", { OLLAMA_BASE_URL: "https://x.example" }, { fetch: async () => { throw new Error("no"); } });
    expect(r.status).toBe("alert");
    expect(r.summary).toContain("OLLAMA_CF_ACCESS_CLIENT_ID");
  });

  it("FAILS when Ollama answers without the token", async () => {
    const r = await checkApp("compplan", ENV, { fetch: fake({ open: 200 }) });
    expect(r.status).toBe("fail");
  });

  it("FAILS when model downloads are not blocked", async () => {
    const r = await checkApp("compplan", ENV, { fetch: fake({ pull: 200 }) });
    expect(r.status).toBe("fail");
  });

  it("alerts when the tunnel is down", async () => {
    const r = await checkApp("compplan", ENV, { fetch: async () => { throw new Error("down"); } });
    expect(r.status).toBe("alert");
  });

  it("alerts when an answer takes over 120 s", async () => {
    let t = 0;
    const r = await checkApp("compplan", ENV, { fetch: fake(), now: () => (t += 130_000) });
    expect(r.checks.find((c) => c.id === "chat")!.status).toBe("alert");
  });

  it("overview shows 'not measured' before any run", () => {
    const o = lenovoOverview({});
    expect(o.find((a) => a.app === "compplan")!.status).toBe("alert");
    expect(o.find((a) => a.app === "compplan")!.summary).toContain("OLLAMA_BASE_URL");
    expect(lenovoOverview(ENV).find((a) => a.app === "compplan")!.status).toBe("not-measured");
    expect(o.find((a) => a.app === "nexus")!.status).toBe("alert");
    expect(o.find((a) => a.app === "10bonds")!.status).toBe("not-connected");
  });

  it("API: overview and run need the token and return results", async () => {
    const app = createApp(openDb(":memory:"), { apiToken: "tok", lenovoEnv: ENV, lenovoFetch: fake() });
    await request(app).get("/api/lenovo").expect(401);
    const run = await request(app).post("/api/lenovo/check").set("authorization", "Bearer tok").send({}).expect(200);
    expect(run.body.find((a: { app: string }) => a.app === "compplan").status).toBe("ok");
    const again = await request(app).get("/api/lenovo").set("authorization", "Bearer tok").expect(200);
    expect(again.body.find((a: { app: string }) => a.app === "compplan").status).toBe("ok");
  });

  it("dashboard column: No / not measured / Yes / Yes, failing per host", async () => {
    expect(lenovoForHost("10bonds.com", ENV).status).toBe("not-connected");
    expect(lenovoForHost("nexus-eendigo.fly.dev", ENV).status).toBe("not-measured");
    expect(lenovoForHost("compplan.onrender.com", ENV).status).toBe("not-measured");
    expect(lenovoForHost("compplan.onrender.com", {}).status).toBe("alert");
    const app = createApp(openDb(":memory:"), { apiToken: "tok", lenovoEnv: ENV, lenovoFetch: fake({ pull: 200 }) });
    await request(app).post("/api/lenovo/check").set("authorization", "Bearer tok").send({}).expect(200);
    const d = await request(app).get("/api/dashboard").set("authorization", "Bearer tok").expect(200);
    const row = (h: string) => d.body.find((a: { host: string }) => a.host === h);
    expect(row("compplan.onrender.com").lenovo.status).toBe("fail");
    expect(row("lm-op-model.fly.dev").lenovo.status).toBe("fail");
  });
});

describe("lenovo passive status from /api/version", () => {
  const ver = (lenovo: unknown): LenovoFetch => async () => ({ status: 200, text: async () => JSON.stringify({ lenovo }) });
  it("online verdict shows ok without any model call or secret", async () => {
    await refreshPassive({}, { fetch: ver({ verdict: "online", say: "Lenovo online." }) });
    const r = lenovoOverview({}).find((x) => x.app === "compplan")!;
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("Lenovo online.");
  });
  it("offline is a failure and a missing block stays not measured", async () => {
    await refreshPassive({}, { fetch: ver({ verdict: "offline", say: "down" }) });
    expect(lenovoOverview({}).find((x) => x.app === "compplan")!.status).toBe("fail");
    resetLenovoCache();
    await refreshPassive({}, { fetch: ver(undefined) });
    expect(lenovoOverview({}).find((x) => x.app === "compplan")!.status).toBe("not-measured");
  });
});
