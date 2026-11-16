import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import request from "supertest";
import { createApp } from "../server/app.js";
import { freshDb } from "./helpers.js";
import { clearDeliveryCache, parseLedger, type GhFetcher } from "../server/delivery/ledger.js";
import { clearHistoryCache, clearHistoryViews, loadHistory, MAX_POINTS } from "../server/delivery/history.js";

const SAMPLE = readFileSync(new URL("./fixtures/delivery-ledger.json", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-16T12:00:00Z");
const R = "https://api.github.com/repos/1903978-prog/compplan";

/** A ledger with `open` open atoms (the rest fully done). */
function ledger(open: number, done = 1): string {
  const atom = (i: number, d: boolean) => {
    const v = d ? "yes" : "no";
    return { id: `task_x_${i}A`, implemented: v, tested: v, merged: v, deployed: v, live_checked: v };
  };
  return JSON.stringify({ atoms: [...Array.from({ length: open }, (_, i) => atom(i, false)), ...Array.from({ length: done }, (_, i) => atom(100 + i, true))] });
}

/** Commits (newest first) in the window and one before it; each sha's file has a known number of open atoms. */
function fakeGh(inWindow: Array<[string, string, number]>, before: Array<[string, string, number]> = []) {
  const calls: { url: string; method: string }[] = [];
  const files = new Map([...inWindow, ...before].map(([sha, , open]) => [sha, ledger(open)]));
  const commit = ([sha, date]: [string, string, number]) => ({ sha, commit: { committer: { date } } });
  const f: GhFetcher = async (url, init) => {
    calls.push({ url, method: init.method });
    const ok = (b: unknown) => ({ status: 200, text: async () => (typeof b === "string" ? b : JSON.stringify(b)) });
    if (url.startsWith(`${R}/commits?`) && url.includes("&since=")) return ok(inWindow.map(commit));
    if (url.startsWith(`${R}/commits?`) && url.includes("&until=")) return ok(before.map(commit));
    const m = url.match(/contents\/docs\/delivery-ledger\.json\?ref=(\w+)$/);
    if (m && files.has(m[1]!)) return ok(files.get(m[1]!)!);
    return { status: 404, text: async () => '{"message":"Not Found"}' };
  };
  return { f, calls };
}

beforeEach(() => {
  clearHistoryCache();
  clearHistoryViews();
  clearDeliveryCache();
});

describe("open atoms over the last 72 hours", () => {
  it("draws one point per change of the ledger file, plus the version in force 72 h ago, oldest first", async () => {
    const { f, calls } = fakeGh(
      [["c3", "2026-11-16T10:00:00Z", 5], ["c2", "2026-11-15T10:00:00Z", 8]],
      [["c1", "2026-11-12T09:00:00Z", 9]],
    );
    const h = await loadHistory("compplan", "main", "t", f, NOW);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(h.from).toBe("2026-11-13T12:00:00.000Z");
    expect(h.points.map((p) => [p.at, p.open, p.total])).toEqual([
      ["2026-11-13T12:00:00.000Z", 9, 10],
      ["2026-11-15T10:00:00Z", 8, 9],
      ["2026-11-16T10:00:00Z", 5, 6],
    ]);
    expect(h.note).toContain("2 change(s)");
    expect(h.note).toContain("in force 72 hours ago");
  });

  it("says so when there is no older version, and leaves unreadable versions out instead of guessing", async () => {
    const { f } = fakeGh([["c2", "2026-11-16T10:00:00Z", 3]]);
    const fWithBroken: GhFetcher = async (url, init) =>
      url.includes("&since=")
        ? { status: 200, text: async () => JSON.stringify([{ sha: "c2", commit: { committer: { date: "2026-11-16T10:00:00Z" } } }, { sha: "zz", commit: { committer: { date: "2026-11-15T10:00:00Z" } } }]) }
        : f(url, init);
    const h = await loadHistory("compplan", "main", "t", fWithBroken, NOW);
    expect(h.points.map((p) => p.open)).toEqual([3]);
    expect(h.note).toContain("No older version");
    expect(h.note).toContain("1 version(s) could not be read");
  });

  it("caps the number of versions read and says how many were left out", async () => {
    const many = Array.from({ length: MAX_POINTS + 5 }, (_, i) => [`s${i}`, new Date(NOW - (i + 1) * 60_000).toISOString(), i] as [string, string, number]);
    const { f } = fakeGh(many);
    const h = await loadHistory("compplan", "main", "t", f, NOW);
    expect(h.points).toHaveLength(MAX_POINTS);
    expect(h.note).toContain("5 older ones");
  });

  it("shows nothing when there is no ledger branch", async () => {
    const { f, calls } = fakeGh([]);
    const h = await loadHistory("lm-op-model", null, "t", f, NOW);
    expect(h.points).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("serves /api/delivery/history for known apps only, signed in", async () => {
    const { f } = fakeGh([["c3", "2026-11-16T10:00:00Z", 5]]);
    const fetcher: GhFetcher = async (url, init) => {
      if (url === R) return { status: 200, text: async () => '{"default_branch":"master"}' };
      if (url === `${R}/contents/docs/delivery-ledger.json?ref=integration`) return { status: 200, text: async () => SAMPLE };
      return f(url, init);
    };
    const app = createApp(freshDb(), { apiToken: "tok", delivery: { env: {}, fetcher, now: () => NOW } });
    await request(app).get("/api/delivery/history?repo=compplan").expect(401);
    await request(app).get("/api/delivery/history?repo=evil").set("authorization", "Bearer tok").expect(400);
    const r = await request(app).get("/api/delivery/history?repo=compplan").set("authorization", "Bearer tok").expect(200);
    expect(r.body.branch).toBe("integration");
    expect(r.body.points.map((p: { open: number }) => p.open)).toEqual([5]);
  });
});

describe("copy table and Claude Code prompt", () => {
  const ctx: { module: { exports: Record<string, (app: unknown) => string> } } = { module: { exports: {} } };
  runInNewContext(readFileSync(new URL("../public/deliveryExtras.js", import.meta.url), "utf8"), ctx);
  const { tableText, promptText } = ctx.module.exports;
  const app = { ...parseLedger("compplan", SAMPLE), branch: "integration" };

  it("copies every atom as a plain-text table", () => {
    const t = tableText!(app);
    expect(t).toContain("Delivery ledger: compplan (compplan), branch integration");
    for (const a of app.atoms) expect(t).toContain(`| ${a.id} |`);
    expect(t).toContain("| task_compplan_003A | 2026-11-16 14:20 | make the button square and yellow | button is square | ✅ | ✅ | ✅ | ❌ | ❌ | deploy |");
  });

  it("lists only open atoms in the prompt, from the ledger only, and forbids merge or deploy without exact-SHA approval", () => {
    const p = promptText!(app);
    expect(p).toContain("Open atoms (3):");
    expect(p).not.toContain("task_compplan_002A"); // fully done
    expect(p).toContain("- task_compplan_003A: button is square");
    expect(p).toContain("Done: Implemented, Tested, Merged");
    expect(p).toContain("Not done: Deployed (not done), Live checked (not done)");
    expect(p).toContain("Next step (from the ledger): deploy");
    expect(p).toContain("Do NOT merge, deploy or change production data without Livio's explicit approval of the exact commit SHA");
    expect(p).toContain("stage by stage");
  });
});
