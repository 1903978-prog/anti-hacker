import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { freshDb } from "./helpers.js";
import {
  clearDeliveryCache,
  getDelivery,
  loadDelivery,
  normStage,
  parseLedger,
  type GhFetcher,
} from "../server/delivery/ledger.js";

const SAMPLE = readFileSync(new URL("./fixtures/delivery-ledger.json", import.meta.url), "utf8");
const GH = "https://api.github.com";

/** Canned GitHub: compplan has a ledger, a discovered extra repo has one, lm-op-model has none, nexus is unreadable. */
function fakeGh() {
  const calls: { url: string; method: string; auth?: string }[] = [];
  const f: GhFetcher = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization });
    const ok = (body: string) => ({ status: 200, text: async () => body });
    const no = { status: 404, text: async () => "{}" };
    if (url === `${GH}/repos/1903978-prog/compplan/contents/docs/delivery-ledger.json`) return ok(SAMPLE);
    if (url === `${GH}/repos/1903978-prog/extra-app/contents/docs/delivery-ledger.json`) return ok(SAMPLE.replace('"project":"compplan"', '"project":"extra"'));
    if (url === `${GH}/repos/1903978-prog/lm-op-model`) return ok("{}");
    if (url === `${GH}/repos/1903978-prog/10bonds/contents/docs/delivery-ledger.json`) return ok("not json");
    if (url.startsWith(`${GH}/user/repos`))
      return ok(JSON.stringify([{ name: "compplan", owner: { login: "1903978-prog" } }, { name: "extra-app", owner: { login: "1903978-prog" } }, { name: "plain", owner: { login: "1903978-prog" } }]));
    return no;
  };
  return { f, calls };
}

beforeEach(() => clearDeliveryCache());

describe("delivery ledger", () => {
  it("maps stage words and symbols to done / not done / parked / unknown", () => {
    expect(["yes", "✅", true, "Passed"].map(normStage)).toEqual(["yes", "yes", "yes", "yes"]);
    expect(["no", "❌", false, "Failed"].map(normStage)).toEqual(["no", "no", "no", "no"]);
    expect(["parked", "⏸"].map(normStage)).toEqual(["parked", "parked"]);
    expect(["maybe", null, "", undefined].map(normStage)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  });

  it("counts atoms by stage; done means all five stages done", () => {
    const a = parseLedger("compplan", SAMPLE);
    expect(a.status).toBe("ok");
    expect(a.counts).toEqual({ total: 4, done: 1, open: 3, implemented: 3, tested: 2, merged: 2, deployed: 1, live_checked: 1 });
    expect(a.atoms.filter((x) => x.done).map((x) => x.id)).toEqual(["task_compplan_002A"]);
    expect(a.atoms[3]!.implemented).toBe("unknown");
    expect(a.lastSynced).toBe("2026-11-16T14:20:00Z");
  });

  it("reports a broken file instead of inventing rows", () => {
    expect(parseLedger("x", "nope").status).toBe("error");
    expect(parseLedger("x", "{}").status).toBe("error");
    const r = parseLedger("x", JSON.stringify({ atoms: [{ id: "" }, { id: "a" }] }));
    expect(r.atoms.map((x) => x.id)).toEqual(["a"]);
    expect(r.message).toContain("1 row");
  });

  it("reads every app with GET only, finds extra ledgers, and tells missing from unreadable", async () => {
    const { f, calls } = fakeGh();
    const v = await loadDelivery({ env: { GITHUB_LEDGER_TOKEN: "t-secret" }, fetcher: f });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.every((c) => c.auth === "Bearer t-secret")).toBe(true);
    expect(v.tokenSet).toBe(true);
    expect(v.apps.map((a) => [a.repo, a.status])).toEqual([
      ["compplan", "ok"],
      ["lm-op-model", "missing"],
      ["nexus-eendigo", "no-access"],
      ["10bonds", "error"],
      ["extra-app", "ok"],
    ]);
    expect(JSON.stringify(v)).not.toContain("t-secret");
  });

  it("falls back to the usage token, caches for 10 minutes, and limits forced refreshes", async () => {
    const { f, calls } = fakeGh();
    let now = 1_000_000;
    const deps = { env: { GITHUB_USAGE_TOKEN: "u" }, fetcher: f, now: () => now };
    await getDelivery(false, deps);
    const first = calls.length;
    expect(calls[0]!.auth).toBe("Bearer u");
    now += 10_000;
    await getDelivery(true, deps); // button pressed 10 s after the last read: still cached
    expect(calls.length).toBe(first);
    now += 5 * 60_000;
    await getDelivery(false, deps); // 5 minutes old: cached
    expect(calls.length).toBe(first);
    await getDelivery(true, deps); // button: re-read
    expect(calls.length).toBe(first * 2);
    now += 11 * 60_000;
    await getDelivery(false, deps); // over 10 minutes old: re-read
    expect(calls.length).toBe(first * 3);
  });

  it("serves /api/delivery only to a signed-in caller", async () => {
    const { f } = fakeGh();
    const app = createApp(freshDb(), { apiToken: "tok", delivery: { env: {}, fetcher: f } });
    await request(app).get("/api/delivery").expect(401);
    const r = await request(app).get("/api/delivery").set("authorization", "Bearer tok").expect(200);
    expect(r.body.apps[0].repo).toBe("compplan");
    expect(r.body.tokenSet).toBe(false);
  });
});
