import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb } from "../server/db.js";
import { seedAllowlist, markProven, addDomain } from "../server/ownership/allowlist.js";
import { createApp } from "../server/app.js";
import { askApp, checkApp, lenovoForHost, lenovoOverview, refreshPassive, resetLenovoCache, type LenovoFetch } from "../server/lenovo/check.js";

const ENV = {
  OLLAMA_BASE_URL: "https://lenovo.example.com/",
  OLLAMA_CF_ACCESS_CLIENT_ID: "id-abc",
  OLLAMA_CF_ACCESS_CLIENT_SECRET: "super-secret-xyz",
  LENOVO_SELFTEST_TOKEN: "selftest-tok-123",
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

/** Every Lenovo request passes the policy gate: the app hosts and the gateway must be proven first. */
function provenDb() {
  const db = openDb(":memory:");
  seedAllowlist(db);
  addDomain(db, "lenovo.example.com", "test", "test gateway");
  for (const h of ["compplan.onrender.com", "nexus-eendigo.fly.dev", "lm-op-model.fly.dev", "lenovo.example.com"]) markProven(db, h, "dns", "test");
  return db;
}

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
    const app = createApp(provenDb(), { apiToken: "tok", lenovoEnv: ENV, lenovoFetch: fake() });
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
    const app = createApp(provenDb(), { apiToken: "tok", lenovoEnv: ENV, lenovoFetch: fake({ pull: 200 }) });
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

describe("lenovo live question test", () => {
  const selftest = (over: { status?: number; body?: unknown } = {}): LenovoFetch => async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/lenovo-selftest") {
      if (init.headers["x-lenovo-selftest"] !== "selftest-tok-123") return { status: 403, text: async () => "{}" };
      const host = new URL(url).hostname;
      const body = over.body ?? (host.startsWith("nexus") ? { ok: false, answer: "", reason: "unreachable: cannot be reached", ms: 40 } : { ok: true, answer: "The capital of Italy is Rome.", reason: "", ms: 1234 });
      return { status: over.status ?? 200, text: async () => JSON.stringify(body) };
    }
    return fake()(url, init);
  };

  it("shows the answer per app, failing apps with their reason, never the secret", async () => {
    const app = createApp(provenDb(), { apiToken: "tok", lenovoEnv: ENV, lenovoFetch: selftest() });
    await request(app).get("/api/lenovo/questions").expect(401);
    const run = await request(app).post("/api/lenovo/questions").set("authorization", "Bearer tok").send({}).expect(200);
    const row = (a: string) => run.body.find((q: { app: string }) => q.app === a);
    expect(row("compplan")).toMatchObject({ status: "ok", question: "What is the capital of Italy?", answer: "The capital of Italy is Rome.", ms: 1234 });
    expect(row("nexus")).toMatchObject({ status: "fail", reason: expect.stringContaining("unreachable") });
    expect(JSON.stringify(run.body)).not.toContain("super-secret-xyz");
    expect(JSON.stringify(run.body)).not.toContain("selftest-tok-123");
    const again = await request(app).get("/api/lenovo/questions").set("authorization", "Bearer tok").expect(200);
    expect(again.body).toHaveLength(3);
  });

  it("plain reasons when the app is not updated yet or the token differs", async () => {
    const q = (s: number) => askApp("compplan", ENV, { fetch: selftest({ status: s }) });
    expect((await q(404)).reason).toContain("not deployed");
    expect((await q(403)).status).toBe("fail");
    expect((await q(401)).reason).toContain("token differs"); // compplan answers 401 since 07 Nov 2026 (compplan#705 F3)
    expect((await askApp("compplan", {}, { fetch: selftest() })).status).toBe("not-measured");
    // The Cloudflare secret is never used as the self-test token (review 13 Nov 2026).
    let called = 0;
    const counting: LenovoFetch = async (url, init) => { called++; return selftest()(url, init); };
    const cfOnly = await askApp("compplan", { OLLAMA_CF_ACCESS_CLIENT_SECRET: "super-secret-xyz" }, { fetch: counting });
    expect(cfOnly.status).toBe("not-measured");
    expect(called).toBe(0);
  });

  it("the Lenovo check also runs the question and the dashboard tooltip carries the answer", async () => {
    const app = createApp(provenDb(), { apiToken: "tok", lenovoEnv: ENV, lenovoFetch: selftest() });
    await request(app).post("/api/lenovo/check").set("authorization", "Bearer tok").send({}).expect(200);
    expect(lenovoForHost("compplan.onrender.com", ENV).summary).toContain('answered: "The capital of Italy is Rome."');
  });
});

describe("lenovo flapping (4/11/2026)", () => {
  const ver = (verdict: string): LenovoFetch => async () => ({ status: 200, text: async () => JSON.stringify({ lenovo: { verdict, say: verdict } }) });
  const cp = () => lenovoForHost("compplan.onrender.com", {}).status;

  it("one bad reading after a good one stays green; the second consecutive one turns it red", async () => {
    const t = 1_000_000_000_000;
    await refreshPassive({}, { fetch: ver("online"), now: () => t });
    expect(cp()).toBe("ok");
    await refreshPassive({}, { fetch: ver("offline"), now: () => t + 6 * 60_000 });
    expect(cp()).toBe("ok");
    await refreshPassive({}, { fetch: ver("offline"), now: () => t + 8 * 60_000 });
    expect(cp()).toBe("fail");
  });

  it("a bad reading is retried once straight away and a good retry wins", async () => {
    let n = 0;
    const flaky: LenovoFetch = async () => ({ status: 200, text: async () => JSON.stringify({ lenovo: { verdict: n++ === 0 ? "offline" : "online", say: "x" } }) });
    await refreshPassive({}, { fetch: flaky, now: () => 2_000_000_000_000 });
    expect(cp()).toBe("ok");
  });
});

describe("lenovo check policy gate", () => {
  it("an unproven gateway or app host is never contacted (rule 5) and shows not measured", async () => {
    const db = openDb(":memory:");
    seedAllowlist(db);
    let calls = 0;
    const app = createApp(db, { apiToken: "tok", lenovoEnv: ENV, lenovoFetch: async () => { calls++; return { status: 200, text: async () => "{}" }; } });
    const r = await request(app).post("/api/lenovo/check").set("authorization", "Bearer tok");
    expect(r.status).toBe(200);
    expect(calls).toBe(0);
    const compplan = r.body.find((x: { app: string }) => x.app === "compplan");
    expect(compplan.status).toBe("not-measured");
    expect(compplan.summary).toContain("policy refused");
  });
});
