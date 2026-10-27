import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { listDeploys, rollbackTo, type RenderFetcher } from "../server/deploy/rollback.js";
import { listAudit } from "../server/audit/log.js";

const ENV = { RENDER_API_KEY: "rnd_secretkey", RENDER_SERVICE_ID: "srv-abc123def456" };
const TOKEN = "test-token-123";
const auth = { authorization: `Bearer ${TOKEN}` };

const DEPLOYS = [
  { deploy: { id: "dep-new000001", status: "live", commit: { id: "aaaaaaa1111", message: "Newest\nbody" }, createdAt: "2026-10-27T05:00:00Z" } },
  { deploy: { id: "dep-old000002", status: "deactivated", commit: { id: "bbbbbbb2222", message: "Older good one" }, createdAt: "2026-10-26T05:00:00Z" } },
  { deploy: { id: "dep-bad000003", status: "build_failed", commit: { id: "ccccccc3333", message: "Broken" }, createdAt: "2026-10-25T05:00:00Z" } },
];

function fakeRender(calls: { url: string; method: string; body?: string }[] = [], rollbackStatus = 201): RenderFetcher {
  return async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === "POST") return { status: rollbackStatus, json: async () => ({}) };
    return { status: 200, json: async () => DEPLOYS };
  };
}

describe("rollback", () => {
  it("shows not connected without a key", async () => {
    const r = await listDeploys({}, fakeRender());
    expect(r.status).toBe("not-connected");
    expect(r.deploys).toEqual([]);
  });

  it("lists deploys and marks which can be rolled back to", async () => {
    const r = await listDeploys(ENV, fakeRender());
    expect(r.status).toBe("ok");
    expect(r.deploys.map((d) => [d.commit, d.current, d.canRollBack])).toEqual([
      ["aaaaaaa", true, false],
      ["bbbbbbb", false, true],
      ["ccccccc", false, false],
    ]);
    expect(r.deploys[0]?.message).toBe("Newest");
    expect(JSON.stringify(r)).not.toContain("rnd_secretkey");
  });

  it("rolls back to an earlier live build", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const r = await rollbackTo("dep-old000002", ENV, fakeRender(calls));
    expect(r.ok).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.render.com/v1/services/srv-abc123def456/rollback");
    expect(JSON.parse(post.body!)).toEqual({ deployId: "dep-old000002" });
  });

  it("refuses the live deploy, a failed build, an unknown id and a malformed id", async () => {
    for (const id of ["dep-new000001", "dep-bad000003", "dep-zzz999999", "../etc/passwd"]) {
      const calls: { url: string; method: string }[] = [];
      const r = await rollbackTo(id, ENV, fakeRender(calls));
      expect(r.ok).toBe(false);
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    }
  });

  it("reports Render refusing, without leaking the key", async () => {
    const r = await rollbackTo("dep-old000002", ENV, fakeRender([], 403));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("403");
    expect(JSON.stringify(r)).not.toContain("rnd_secretkey");
  });
});

describe("rollback api", () => {
  function app(calls: { url: string; method: string }[] = []) {
    const db = openDb(":memory:");
    return { db, a: createApp(db, { apiToken: TOKEN, renderEnv: ENV, renderFetch: fakeRender(calls) }) };
  }

  it("needs the token", async () => {
    const { a } = app();
    expect((await request(a).get("/api/deploys")).status).toBe(401);
    expect((await request(a).post("/api/rollback").send({ deployId: "dep-old000002" })).status).toBe(401);
  });

  it("lists deploys and audits a rollback", async () => {
    const calls: { url: string; method: string }[] = [];
    const { db, a } = app(calls);
    const list = await request(a).get("/api/deploys").set(auth);
    expect(list.body.deploys).toHaveLength(3);
    const res = await request(a).post("/api/rollback").set(auth).send({ deployId: "dep-old000002" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const row = listAudit(db, 10).find((e) => e.action === "rollback");
    expect(row?.decision).toBe("allow");
    expect(row?.target).toBe("dep-old000002");
  });

  it("answers 409 and audits a refused rollback", async () => {
    const { db, a } = app();
    const res = await request(a).post("/api/rollback").set(auth).send({ deployId: "dep-new000001" });
    expect(res.status).toBe(409);
    expect(listAudit(db, 10).find((e) => e.action === "rollback")?.decision).toBe("deny");
  });

  it("rejects a missing deployId", async () => {
    const { a } = app();
    expect((await request(a).post("/api/rollback").set(auth).send({})).status).toBe(400);
  });
});
