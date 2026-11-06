import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { loadCompliance, summarise, STALE_AFTER_DAYS } from "../server/aeos/compliance.js";

const TOKEN = "test-token-123";
const auth = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-11-06T12:00:00Z");

function app(file: string) {
  return {
    a: createApp(openDb(":memory:"), { apiToken: TOKEN, aeosFile: file }),
  };
}
function write(doc: unknown): string {
  const f = join(mkdtempSync(join(tmpdir(), "aeos-test-")), "aeos-compliance.json");
  writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc));
  return f;
}
const pr = { number: 1, html_url: "https://github.com/o/r/pull/1", state: "open", draft: true, mergeable_state: "clean" };
const goodApp = (over: Record<string, unknown> = {}) => ({
  application: "Alpha",
  installed: true,
  score: 90,
  aeos_version: "1.0.0",
  validate: { ok: true, output: ["AEOS validate: OK"] },
  own_tests: { ran: 21, ok: true },
  backlog: { total: 4, verified: 1, unverified: 3, open_p0_p1: 1 },
  open_blockers: 0,
  unverified_items: ["live state"],
  outstanding_approvals: ["merge", "deploy"],
  pr,
  ...over,
});
const doc = (apps: unknown[], collected = "2026-11-06T09:00:00Z") => ({
  schema: 1,
  collected_at: collected,
  collector: "scripts/aeos/collect.py",
  realtime: false,
  refresh: "run collect.py again",
  score_basis: { installed: 20 },
  apps,
});

describe("aeos compliance file", () => {
  it("reports no data, never zeros, when the file is missing", () => {
    const r = loadCompliance(join(tmpdir(), "does-not-exist-aeos.json"), NOW);
    expect(r.status).toBe("no-data");
    expect(r.apps).toBeUndefined();
    expect(r.summary).toBeUndefined();
    expect(r.realtime).toBe(false);
  });

  it("summarises real values per app and in total", () => {
    const r = loadCompliance(write(doc([goodApp(), goodApp({ application: "Beta", score: 70, own_tests: { ran: 21, ok: false }, backlog: { total: 2, verified: 0, unverified: 2, open_p0_p1: 0 } })])), NOW);
    expect(r.status).toBe("ok");
    expect(r.summary).toEqual({
      apps: 2, installed: 2, validationOk: 2, testsPassing: 1, averageScore: 80,
      openP0P1: 1, verifiedTasks: 1, unverifiedTasks: 5, unverifiedItems: 2, outstandingApprovals: 4,
    });
  });

  it("flags data older than the stale limit instead of presenting it as current", () => {
    const old = new Date(NOW.getTime() - (STALE_AFTER_DAYS + 1) * 86_400_000).toISOString();
    const r = loadCompliance(write(doc([goodApp()], old)), NOW);
    expect(r.status).toBe("stale");
    expect(r.ageDays).toBeGreaterThan(STALE_AFTER_DAYS);
    // just inside the limit stays ok
    const fresh = new Date(NOW.getTime() - (STALE_AFTER_DAYS - 1) * 86_400_000).toISOString();
    expect(loadCompliance(write(doc([goodApp()], fresh)), NOW).status).toBe("ok");
  });

  it("refuses broken files with a reason and does not throw", () => {
    expect(loadCompliance(write("{not json"), NOW)).toMatchObject({ status: "invalid" });
    expect(loadCompliance(write(doc([])), NOW).status).toBe("invalid"); // no apps = not a report
    const noRealtimeFlag = { ...doc([goodApp()]), realtime: true };
    expect(loadCompliance(write(noRealtimeFlag), NOW).status).toBe("invalid"); // may never claim real-time
    expect(loadCompliance(write(doc([goodApp({ score: 140 })])), NOW).error).toMatch(/score/);
  });

  it("only accepts github.com pull request links", () => {
    const bad = loadCompliance(write(doc([goodApp({ pr: { ...pr, html_url: "https://evil.example/x" } })])), NOW);
    expect(bad.status).toBe("invalid");
    const js = loadCompliance(write(doc([goodApp({ pr: { ...pr, html_url: "javascript:alert(1)" } })])), NOW);
    expect(js.status).toBe("invalid");
  });

  it("an app that is not enrolled counts as not installed", () => {
    const s = summarise([goodApp({ installed: false, score: 0, validate: undefined, own_tests: undefined, backlog: undefined }) as never]);
    expect(s.installed).toBe(0);
    expect(s.validationOk).toBe(0);
    expect(s.testsPassing).toBe(0);
  });
});

describe("GET /api/aeos", () => {
  it("is private: no token and a wrong token both get 401", async () => {
    const { a } = app(write(doc([goodApp()])));
    expect((await request(a).get("/api/aeos")).status).toBe(401);
    expect((await request(a).get("/api/aeos").set({ authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("serves the collected data with the token, uncached", async () => {
    const { a } = app(write(doc([goodApp()], new Date().toISOString())));
    const res = await request(a).get("/api/aeos").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.apps[0].application).toBe("Alpha");
    expect(res.body.realtime).toBe(false);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("says so when nothing was collected", async () => {
    const { a } = app(join(tmpdir(), "missing-aeos-file.json"));
    const res = await request(a).get("/api/aeos").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no-data");
  });
});
