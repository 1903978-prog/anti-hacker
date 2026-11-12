import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { freshDb } from "./helpers.js";
import { createApp } from "../server/app.js";
import { markProven } from "../server/ownership/allowlist.js";
import { engage } from "../server/governance/killswitch.js";
import type { DB } from "../server/db.js";
import {
  FRESH_STATE, applyAlerts, defaultProbes, matrix, nextState, pruneSamples, reportTick, resetMonitor, restoreStates,
  refreshNow, runDue, runProbe, selftestProbe, summaryText, tenBondsProbe, uptime, versionProbe, alertState, type MonitorFetch,
} from "../server/lenovo/monitor.js";

const HOSTS = ["compplan.onrender.com", "nexus-eendigo.fly.dev", "lm-op-model.fly.dev", "10bonds.com"];
function proven(): DB {
  const db = freshDb();
  for (const h of HOSTS) markProven(db, h, "dns", "test");
  return db;
}
const ok = (status: number, body: unknown) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const T0 = Date.parse("2026-11-12T08:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

beforeEach(() => resetMonitor());

describe("alert state machine", () => {
  it("warns after 2 failures, goes critical after 5 minutes, recovers after 3 good checks", () => {
    let s = FRESH_STATE;
    let r = nextState(s, false, at(0)); s = r.state; expect(r.transition).toBeNull();
    r = nextState(s, false, at(1)); s = r.state; expect(r.transition).toBe("warning");
    r = nextState(s, false, at(3)); s = r.state; expect(r.transition).toBeNull();
    r = nextState(s, false, at(5)); s = r.state; expect(r.transition).toBe("critical");
    r = nextState(s, false, at(6)); s = r.state; expect(r.transition).toBeNull();
    r = nextState(s, true, at(7)); s = r.state; expect(r.transition).toBeNull();
    r = nextState(s, true, at(8)); s = r.state; expect(r.transition).toBeNull();
    r = nextState(s, true, at(9)); s = r.state; expect(r.transition).toBe("recovered");
    expect(s.status).toBe("ok");
  });
  it("one failure then a good check never alerts; not measured changes nothing", () => {
    let r = nextState(FRESH_STATE, false, at(0));
    r = nextState(r.state, null, at(1));
    expect(r.state.fails).toBe(1);
    r = nextState(r.state, true, at(2));
    expect(r.state).toEqual(FRESH_STATE);
  });
  it("two failed 5-minute checks are a warning and critical at once", () => {
    const a = nextState(FRESH_STATE, false, at(0));
    const b = nextState(a.state, false, at(5));
    expect(b.transition).toBe("critical");
  });
  it("a bad check between good ones during recovery restarts the count", () => {
    let s = nextState(nextState(FRESH_STATE, false, at(0)).state, false, at(1)).state; // warning
    s = nextState(s, true, at(2)).state;
    s = nextState(s, true, at(3)).state;
    s = nextState(s, false, at(4)).state;
    expect(s.status).toBe("warning");
    expect(s.oks).toBe(0);
  });
});

describe("probes", () => {
  it("compplan /api/version gives the app row and the shared machine rows from its own data", async () => {
    const f: MonitorFetch = async () => ok(200, { lenovo: { verdict: "online", say: "Lenovo online", gateway: { ok_age_s: 30 }, worker: { seen_age_s: 12, ollama_ok: true } } });
    const s = await versionProbe("compplan", "compplan.onrender.com").run(f, {});
    expect(s.find((x) => x.app === "compplan" && x.level === 4)?.ok).toBe(true);
    expect(s.find((x) => x.app === "lenovo" && x.level === 1)?.ok).toBe(true);
    expect(s.find((x) => x.app === "lenovo" && x.level === 2)?.ok).toBe(true);
  });
  it("Ollama down on the Lenovo fails level 2 but level 1 still sees the machine", async () => {
    const f: MonitorFetch = async () => ok(200, { lenovo: { verdict: "ollama_down_on_lenovo", say: "x", gateway: {}, worker: { seen_age_s: 5, ollama_ok: false } } });
    const s = await versionProbe("compplan", "compplan.onrender.com").run(f, {});
    expect(s.find((x) => x.app === "lenovo" && x.level === 1)?.ok).toBe(true);
    expect(s.find((x) => x.app === "lenovo" && x.level === 2)?.ok).toBe(false);
    expect(s.find((x) => x.app === "compplan" && x.level === 4)?.ok).toBe(false);
  });
  it("an app that is itself down is 'not measured', never a Lenovo failure", async () => {
    const f: MonitorFetch = async () => { throw new Error("down"); };
    const s = await versionProbe("nexus", "nexus-eendigo.fly.dev").run(f, {});
    expect(s).toHaveLength(1);
    expect(s[0]!.ok).toBeNull();
  });
  it("a shared-gateway reading never fills another app's row", async () => {
    const f: MonitorFetch = async () => ok(200, { lenovo: { verdict: "online", say: "ok", gateway: { ok_age_s: 1 }, worker: { seen_age_s: 1, ollama_ok: true } } });
    const s = await versionProbe("compplan", "compplan.onrender.com").run(f, {});
    expect(s.every((x) => x.app === "compplan" || x.app === "lenovo")).toBe(true);
  });
  it("10bonds: connected but completing nothing while jobs wait fails level 5", async () => {
    const f: MonitorFetch = async () => ok(200, { connected: true, lastSeenSecondsAgo: 10, jobsDoneLastHour: 0, queued: 17123, processing: 1 });
    const s = await tenBondsProbe().run(f, {});
    expect(s.find((x) => x.level === 4)?.ok).toBe(true);
    expect(s.find((x) => x.level === 5)?.ok).toBe(false);
  });
  it("10bonds: a silent worker fails level 4; jobs done keep level 5 healthy", async () => {
    const down = await tenBondsProbe().run(async () => ok(200, { connected: false, lastSeenSecondsAgo: 820000, jobsDoneLastHour: 0, queued: 5, processing: 0 }), {});
    expect(down.find((x) => x.level === 4)?.ok).toBe(false);
    expect(down.find((x) => x.level === 3)?.ok).toBeNull();
    const up = await tenBondsProbe().run(async () => ok(200, { connected: true, lastSeenSecondsAgo: 3, jobsDoneLastHour: 20, queued: 100, processing: 1 }), {});
    expect(up.find((x) => x.level === 5)?.ok).toBe(true);
  });
  it("self-test: no token is not measured; a refused token fails level 3; a real answer passes level 5", async () => {
    const p = selftestProbe("lm-op-model", "lm-op-model.fly.dev");
    expect((await p.run(async () => { throw new Error("must not call"); }, {})).every((x) => x.ok === null)).toBe(true);
    const refused = await p.run(async () => ok(403, "{}"), { LENOVO_SELFTEST_TOKEN: "t" });
    expect(refused.find((x) => x.level === 3)?.ok).toBe(false);
    let sent: Record<string, string> = {};
    const good = await p.run(async (_u, init) => { sent = init.headers; return ok(200, { ok: true, answer: "Rome.", ms: 4200 }); }, { LENOVO_SELFTEST_TOKEN: "t" });
    expect(sent["x-lenovo-selftest"]).toBe("t");
    expect(good.find((x) => x.level === 5)?.ok).toBe(true);
    expect(good.map((x) => x.detail).join(" ")).not.toContain("t\"");
    const wrong = await p.run(async () => ok(200, { ok: false, reason: "answer does not mention Rome" }), { LENOVO_SELFTEST_TOKEN: "t" });
    expect(wrong.find((x) => x.level === 5)?.ok).toBe(false);
  });
});

describe("policy gate, storage and reporting", () => {
  it("an unproven host is never contacted and is recorded as not measured", async () => {
    const db = freshDb();
    let calls = 0;
    const s = await runProbe(db, tenBondsProbe(), {}, async () => { calls++; return ok(200, {}); }, { now: () => new Date(T0) });
    expect(calls).toBe(0);
    expect(s.every((x) => x.ok === null)).toBe(true);
    expect(uptime(db, "10bonds", 4, at(-60)).notMeasured).toBe(1);
  });
  it("the kill switch stops every probe", async () => {
    const db = proven();
    engage(db, "test", "test");
    let calls = 0;
    await runDue(db, defaultProbes(), { LENOVO_SELFTEST_TOKEN: "t" }, async () => { calls++; return ok(200, {}); });
    expect(calls).toBe(0);
  });
  it("runs due probes one at a time and respects each cadence", async () => {
    const db = proven();
    let inFlight = 0, maxInFlight = 0, calls = 0;
    const f: MonitorFetch = async () => {
      calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return ok(200, { lenovo: { verdict: "online", say: "ok" }, ok: true, answer: "Rome", connected: true, jobsDoneLastHour: 1, queued: 0, processing: 0 });
    };
    let now = new Date(T0);
    const deps = { now: () => now, cfg: { apiKey: null, to: "x", from: "y" } };
    expect(await runDue(db, defaultProbes(), { LENOVO_SELFTEST_TOKEN: "t" }, f, deps)).toBe(7);
    expect(maxInFlight).toBe(1);
    now = new Date(T0 + 60_000);
    expect(await runDue(db, defaultProbes(), { LENOVO_SELFTEST_TOKEN: "t" }, f, deps)).toBe(3); // only the 1-minute probes
    now = new Date(T0 + 5 * 60_000);
    expect(await runDue(db, defaultProbes(), { LENOVO_SELFTEST_TOKEN: "t" }, f, deps)).toBe(7);
    expect(calls).toBe(17);
  });
  it("a critical alert is recorded, audited and mailed once; recovery is mailed after it", async () => {
    const db = proven();
    const mails: string[] = [];
    const deps = (m: number) => ({ now: () => new Date(T0 + m * 60_000), cfg: { apiKey: "k", to: "a@b", from: "c@d" }, send: async (msg: { subject: string }) => { mails.push(msg.subject); } });
    const bad = { app: "10bonds" as const, level: 4 as const, ok: false, ms: 1, detail: "Worker NOT connected" };
    const good = { ...bad, ok: true, detail: "Worker connected" };
    for (const m of [0, 5, 10, 15]) await applyAlerts(db, at(m), [bad], deps(m));
    expect(mails.filter((s) => s.includes("CRITICAL"))).toHaveLength(1);
    for (const m of [20, 25, 30]) await applyAlerts(db, at(m), [good], deps(m));
    expect(mails.filter((s) => s.includes("recovered"))).toHaveLength(1);
    const states = (db.prepare(`SELECT state FROM lenovo_alerts ORDER BY id`).all() as Array<{ state: string }>).map((r) => r.state);
    expect(states).toEqual(["critical", "recovered"]);
    expect(() => db.prepare(`DELETE FROM lenovo_alerts`).run()).toThrow(/append-only/);
    const audits = db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'lenovo.%'`).get() as { n: number };
    expect(audits.n).toBe(2);
  });
  it("uptime counts only measured readings and the matrix marks levels that do not apply", async () => {
    const db = proven();
    const now = new Date(T0);
    const f: MonitorFetch = async () => ok(200, { connected: true, lastSeenSecondsAgo: 3, jobsDoneLastHour: 0, queued: 9, processing: 0 });
    await runProbe(db, tenBondsProbe(), {}, f, { now: () => now, cfg: { apiKey: null, to: "", from: "" } });
    const u5 = uptime(db, "10bonds", 5, at(-60));
    expect(u5).toEqual({ ok: 0, fail: 1, notMeasured: 0, pct: 0 });
    expect(uptime(db, "10bonds", 4, at(-60)).pct).toBe(100);
    const m = matrix(db, now);
    const tb = m.find((r) => r.app === "10bonds")!;
    expect(tb.cells.find((c) => c.level === 1)!.applies).toBe(false);
    expect(tb.cells.find((c) => c.level === 5)!.last?.ok).toBe(false);
    expect(summaryText(db, 1, now)).toContain("10bonds");
    expect(summaryText(db, 1, now)).toContain("not measured");
  });
  it("restoring after a restart rebuilds the alert state from stored readings", async () => {
    const db = proven();
    const f: MonitorFetch = async () => ok(200, { connected: false, lastSeenSecondsAgo: 9999, jobsDoneLastHour: 0, queued: 9, processing: 0 });
    const cfg = { apiKey: null, to: "", from: "" };
    await runProbe(db, tenBondsProbe(), {}, f, { now: () => new Date(T0), cfg });
    await runProbe(db, tenBondsProbe(), {}, f, { now: () => new Date(T0 + 5 * 60_000), cfg });
    expect(alertState("10bonds", 4).status).toBe("critical");
    resetMonitor();
    expect(alertState("10bonds", 4).status).toBe("ok");
    restoreStates(db, new Date(T0 + 6 * 60_000));
    expect(alertState("10bonds", 4).status).toBe("critical");
  });
  it("readings are pruned after 90 days; daily and weekly reports go out once", async () => {
    const db = proven();
    db.prepare(`INSERT INTO lenovo_samples (ts, app, level, probe, ok, ms, detail) VALUES (?, '10bonds', 4, 'x', 1, 1, 'old')`).run(new Date(T0 - 91 * 86_400_000).toISOString());
    expect(pruneSamples(db, new Date(T0))).toBe(1);
    const subjects: string[] = [];
    const monday = new Date("2026-11-16T07:30:00Z");
    const deps = { now: () => monday, cfg: { apiKey: "k", to: "a", from: "b" }, send: async (m: { subject: string }) => { subjects.push(m.subject); } };
    expect(await reportTick(db, deps)).toBe("both");
    expect(await reportTick(db, deps)).toBe("none");
    expect(subjects).toHaveLength(2);
    expect(await reportTick(db, { ...deps, now: () => new Date("2026-11-17T06:00:00Z") })).toBe("none");
  });
  it("GET /api/lenovo/matrix and /api/lenovo/summary need the login and show no secret", async () => {
    const db = proven();
    const app = createApp(db, { apiToken: "secret-token" });
    expect((await request(app).get("/api/lenovo/matrix")).status).toBe(401);
    const m = await request(app).get("/api/lenovo/matrix").set("authorization", "Bearer secret-token");
    expect(m.status).toBe(200);
    expect(m.body.rows.map((r: { app: string }) => r.app)).toEqual(["lenovo", "compplan", "nexus", "lm-op-model", "10bonds"]);
    const s = await request(app).get("/api/lenovo/summary?days=7").set("authorization", "Bearer secret-token");
    expect(s.status).toBe(200);
    expect(s.text).toContain("last 7 days");
    expect(JSON.stringify(m.body) + s.text).not.toContain("secret-token");
  });
});

describe("on demand only (Livio, 12 Nov 2026)", () => {
  it("no timer starts the monitor: index.ts never imports it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/startLenovoMonitor|lenovo\/monitor/);
    const mon = readFileSync(new URL("../server/lenovo/monitor.ts", import.meta.url), "utf8");
    expect(mon).not.toMatch(/setInterval|startLenovoMonitor/);
  });
  it("Refresh runs every probe once, one at a time, and sends no e-mail", async () => {
    const db = proven();
    let inFlight = 0, maxInFlight = 0, calls = 0, mails = 0;
    const f: MonitorFetch = async () => {
      calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return ok(500, "down");
    };
    const deps = { now: () => new Date(T0), cfg: { apiKey: "k", to: "x", from: "y" }, send: async () => { mails++; return true; } };
    expect(await refreshNow(db, defaultProbes(), { LENOVO_SELFTEST_TOKEN: "t" }, f, deps as never)).toBe(7);
    expect(await refreshNow(db, defaultProbes(), { LENOVO_SELFTEST_TOKEN: "t" }, f, deps as never)).toBe(7);
    expect(maxInFlight).toBe(1);
    expect(calls).toBe(14);
    expect(mails).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM lenovo_alerts").get() as { n: number }).n).toBe(0);
  });
  it("the kill switch still stops every probe on Refresh", async () => {
    const db = proven();
    engage(db, "test", "test");
    let calls = 0;
    await refreshNow(db, defaultProbes(), { LENOVO_SELFTEST_TOKEN: "t" }, async () => { calls++; return ok(200, {}); });
    expect(calls).toBe(0);
  });
  it("POST /api/lenovo/matrix/refresh needs login and returns the fresh matrix", async () => {
    const db = proven();
    const app = createApp(db, { apiToken: "secret-token", lenovoEnv: { LENOVO_SELFTEST_TOKEN: "t" }, lenovoFetch: async () => ok(200, { lenovo: { verdict: "online", say: "ok" }, ok: true, answer: "Rome", connected: true, jobsDoneLastHour: 1, queued: 0, processing: 0 }) });
    expect((await request(app).post("/api/lenovo/matrix/refresh")).status).toBe(401);
    const r = await request(app).post("/api/lenovo/matrix/refresh").set("authorization", "Bearer secret-token");
    expect(r.status).toBe(200);
    expect(r.body.probesRun).toBe(7);
    expect(r.body.rows.find((x: { app: string }) => x.app === "nexus").cells[3].last.ok).toBe(true);
  });
});
