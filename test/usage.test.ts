import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import {
  allUsage,
  appFor,
  clearUsageCache,
  flyMachineMonthly,
  flyUsage,
  neonUsage,
  githubUsage,
  renderUsage,
  type Fetcher,
} from "../server/usage/providers.js";

const NOW = new Date("2026-10-20T12:00:00Z");

/** Canned API answers by URL prefix; records every call. */
function fake(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return { status: 404, json: async () => ({}) };
    return { status, json: async () => routes[key] };
  };
  return { f, calls };
}

beforeEach(() => clearUsageCache());

describe("usage counters", () => {
  it("shows not connected, without calling anything, when no token is set", async () => {
    const { f, calls } = fake({});
    const { providers } = await allUsage({ env: {}, fetcher: f, now: NOW });
    expect(providers.map((p) => [p.id, p.status])).toEqual([
      ["github", "not-connected"],
      ["render", "not-connected"],
      ["fly", "not-connected"],
      ["neon", "not-connected"],
      ["backblaze", "info"],
    ]);
    expect(calls).toHaveLength(0);
  });

  it("adds up GitHub Actions minutes and the billed amount for this month", async () => {
    const { f, calls } = fake({
      "https://api.github.com/users/1903978-prog/settings/billing/usage": {
        usageItems: [
          { product: "actions", sku: "linux", unitType: "Minutes", quantity: 300, netAmount: 0, repositoryName: "1903978-prog/compplan" },
          { product: "actions", sku: "linux", unitType: "Minutes", quantity: 1500, netAmount: 0, repositoryName: "1903978-prog/compplan" },
          { product: "actions", sku: "linux", unitType: "Minutes", quantity: 100, netAmount: 1.6, repositoryName: "1903978-prog/nexus" },
          { product: "packages", sku: "storage", unitType: "GigabyteHours", quantity: 1068, netAmount: 0 },
        ],
      },
    });
    const g = await githubUsage({ GITHUB_USAGE_TOKEN: "ghp_secret" }, f, NOW);
    expect(g.status).toBe("ok");
    expect(calls[0]!.url).toContain("year=2026&month=10");
    expect(calls[0]!.headers.authorization).toBe("Bearer ghp_secret");
    expect(g.meters[0]).toMatchObject({ used: 1900, limit: 2000, unit: "min" });
    expect(g.meters[1]!.used).toBe(2.28); // 1068 GB-hours over 468 hours so far
    expect(g.meters[2]).toMatchObject({ used: 1.6, unit: "USD" });
    expect(g.rows[0]).toMatchObject({ name: "1903978-prog/compplan", app: "compplan" });
    expect(g.rows[0]!.metrics[0]).toMatchObject({ value: 1800, unit: "min" });
    expect(g.rows.find((r) => r.app === "nexus")!.metrics[2]).toMatchObject({ value: 1.6, unit: "USD" });
  });

  it("never passes the token or the provider's error text on", async () => {
    const { f } = fake({ "https://api.github.com/": { message: "Bad credentials ghp_secret" } }, 401);
    const g = await githubUsage({ GITHUB_USAGE_TOKEN: "ghp_secret" }, f, NOW);
    expect(g.status).toBe("error");
    expect(g.message).toMatch(/token was refused \(HTTP 401\)/);
    expect(JSON.stringify(g)).not.toContain("ghp_secret");
  });

  it("lists Render services and sums this month's bandwidth", async () => {
    const { f, calls } = fake({
      "https://api.render.com/v1/services": [
        { cursor: "a", service: { id: "srv-1", name: "secval", type: "web_service", suspended: "not_suspended", serviceDetails: { plan: "free" } } },
        { cursor: "b", service: { id: "srv-2", name: "compplan", type: "web_service", suspended: "suspended", serviceDetails: { plan: "free" } } },
      ],
      "https://api.render.com/v1/metrics/bandwidth?resource=srv-1": [
        { unit: "mb", values: [{ timestamp: "t", value: 1500 }, { timestamp: "t", value: 500 }] },
      ],
      "https://api.render.com/v1/metrics/bandwidth?resource=srv-2": { data: [{ unit: "mb", values: [{ value: 2000 }] }] },
    });
    const r = await renderUsage({ RENDER_API_KEY: "rnd_secret" }, f, NOW);
    expect(r.status).toBe("ok");
    expect(r.meters[0]).toMatchObject({ used: 4, limit: 5, unit: "GB" });
    expect(r.meters[1]).toMatchObject({ used: 2, unit: "services, 1 suspended" });
    expect(r.rows.map((x) => [x.app, x.metrics[0]!.value])).toEqual([["secval", 2], ["compplan", 2]]);
    expect(r.rows[1]!.note).toContain("SUSPENDED");
    const bw = calls.filter((c) => c.url.includes("/metrics/bandwidth"));
    expect(bw).toHaveLength(2);
    expect(bw[0]!.url).toContain("startTime=2026-10-01T00%3A00%3A00.000Z");
  });

  it("still shows Render services when bandwidth cannot be read", async () => {
    const { f } = fake({ "https://api.render.com/v1/services": [{ service: { id: "srv-1", name: "secval" } }] });
    const r = await renderUsage({ RENDER_API_KEY: "k" }, f, NOW);
    expect(r.status).toBe("ok");
    expect(r.meters[0]!.used).toBeNull();
    expect(r.meters[0]!.note).toMatch(/Could not read bandwidth/);
  });

  it("counts Fly machines and estimates the monthly cost", async () => {
    const guest = { cpu_kind: "shared", cpus: 1, memory_mb: 1024 };
    const { f } = fake({
      "https://api.machines.dev/v1/apps?": { total_apps: 1, apps: [{ name: "nexus-eendigo", machine_count: 2 }] },
      "https://api.machines.dev/v1/apps/nexus-eendigo/machines": [
        { state: "started", region: "iad", config: { guest } },
        { state: "stopped", region: "iad", config: { guest } },
      ],
    });
    const fl = await flyUsage({ FLY_API_TOKEN: "fo1_secret" }, f, NOW);
    expect(fl.status).toBe("ok");
    expect(fl.meters[0]).toMatchObject({ used: 1, limit: null, unit: "of 2 machines" });
    expect(fl.meters[1]).toMatchObject({ used: 6.69, estimate: true });
    expect(fl.meters[2]!.used).toBe(13.38);
    expect(fl.rows[0]).toMatchObject({ name: "nexus-eendigo", app: "nexus" });
    expect(fl.rows[0]!.metrics[1]).toMatchObject({ value: 6.69, estimate: true });
  });

  it("shows Neon compute and data out per project, tagged by app", async () => {
    const { f, calls } = fake({
      "https://console.neon.tech/api/v2/projects?": { projects: [{ id: "p-1", name: "10bonds-prod" }, { id: "p-2", name: "atlas-main" }] },
      "https://console.neon.tech/api/v2/projects/p-1": { project: { compute_time_seconds: 7200, data_transfer_bytes: 2_500_000_000 } },
      "https://console.neon.tech/api/v2/projects/p-2": { project: { compute_time_seconds: 36000, data_transfer_bytes: 100_000_000 } },
    });
    const n = await neonUsage({ NEON_API_KEY: "napi_secret", NEON_PROJECT_APPS: "atlas-main=compplan" }, f, NOW);
    expect(n.status).toBe("ok");
    expect(calls[0]!.headers.authorization).toBe("Bearer napi_secret");
    expect(n.rows.map((r) => [r.app, r.metrics[0]!.value, r.metrics[1]!.value])).toEqual([
      ["10bonds", 2, 2.5],
      ["compplan", 10, 0.1],
    ]);
    expect(n.meters[1]).toMatchObject({ used: 12, unit: "hours" });
    expect(JSON.stringify(n)).not.toContain("napi_secret");
  });

  it("reports a refused Neon key plainly", async () => {
    const { f } = fake({ "https://console.neon.tech/": {} }, 403);
    const n = await neonUsage({ NEON_API_KEY: "k" }, f, NOW);
    expect(n.status).toBe("error");
    expect(n.message).toMatch(/refused \(HTTP 403\)/);
  });

  it("prices Fly machines close to Fly's own list", () => {
    expect(flyMachineMonthly({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }, "iad")).toBeCloseTo(2.19, 1);
    expect(flyMachineMonthly({ cpu_kind: "shared", cpus: 2, memory_mb: 2048 }, "iad")).toBeCloseTo(13.39, 1);
    expect(flyMachineMonthly({ cpu_kind: "performance", cpus: 1, memory_mb: 2048 }, "iad")).toBeCloseTo(33, 0);
  });

  it("groups usage by app across providers", async () => {
    const { f } = fake({
      "https://api.github.com/": { usageItems: [
        { product: "actions", unitType: "Minutes", quantity: 50, repositoryName: "1903978-prog/anti-hacker" },
        { product: "actions", unitType: "Minutes", quantity: 9, repositoryName: "1903978-prog/sandbox" },
      ] },
      "https://api.render.com/v1/services": [{ service: { id: "srv-1", name: "secval" } }],
      "https://api.render.com/v1/metrics/bandwidth": [{ unit: "mb", values: [{ value: 300 }] }],
    });
    const { byApp } = await allUsage({ env: { GITHUB_USAGE_TOKEN: "t", RENDER_API_KEY: "k" }, fetcher: f, now: NOW });
    expect(byApp.map((a) => a.app)).toEqual(["compplan", "lm-op-model", "nexus", "10bonds", "secval", "eendigo", "other"]);
    const secval = byApp.find((a) => a.app === "secval")!;
    expect(secval.lines.map((l) => [l.provider, l.name])).toEqual([["GitHub", "1903978-prog/anti-hacker"], ["Render", "secval"]]);
    expect(byApp.find((a) => a.app === "other")!.lines[0]!.name).toBe("1903978-prog/sandbox");
  });

  it("matches provider names to apps", () => {
    expect(appFor("nexus-eendigo")).toBe("nexus");
    expect(appFor("1903978-prog/anti-hacker")).toBe("secval");
    expect(appFor("lm-op-model-staging")).toBe("lm-op-model");
    expect(appFor("10bonds")).toBe("10bonds");
    expect(appFor("something-else")).toBe("other");
  });

  it("caches results and limits manual refreshes", async () => {
    const { f, calls } = fake({ "https://api.github.com/": { usageItems: [] } });
    const env = { GITHUB_USAGE_TOKEN: "t" };
    await allUsage({ env, fetcher: f, now: NOW });
    await allUsage({ env, fetcher: f, now: new Date(NOW.getTime() + 5 * 60_000) });
    expect(calls).toHaveLength(1);
    await allUsage({ env, fetcher: f, now: new Date(NOW.getTime() + 30_000), refresh: true });
    expect(calls).toHaveLength(1); // under a minute: still cached
    await allUsage({ env, fetcher: f, now: new Date(NOW.getTime() + 6 * 60_000), refresh: true });
    expect(calls).toHaveLength(2);
  });

  it("is private: the usage page needs the secret token", async () => {
    const a = createApp(openDb(":memory:"), { apiToken: "tok" });
    expect((await request(a).get("/api/usage")).status).toBe(401);
  });
});
