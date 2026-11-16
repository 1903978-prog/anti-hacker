import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { freshDb } from "./helpers.js";
import {
  clearDeliveryCache,
  getDelivery,
  loadDelivery,
  loadSnapshot,
  normStage,
  parseLedger,
  atomProgress,
  labelFor,
  type GhFetcher,
} from "../server/delivery/ledger.js";

const SAMPLE = readFileSync(new URL("./fixtures/delivery-ledger.json", import.meta.url), "utf8");
const GH = "https://api.github.com";

/**
 * Canned GitHub: compplan has its ledger only on an open PR branch, extra-app on integration,
 * lm-op-model has none, nexus-eendigo is unreadable (404 "Not Found"), 10bonds has a broken file.
 */
function fakeGh() {
  const calls: { url: string; method: string; auth?: string }[] = [];
  const f: GhFetcher = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization });
    const ok = (body: string) => ({ status: 200, text: async () => body });
    const no = { status: 404, text: async () => JSON.stringify({ message: "Not Found" }) };
    const R = `${GH}/repos/1903978-prog/`;
    const C = "/contents/docs/delivery-ledger.json?ref=";
    if (["compplan", "lm-op-model", "10bonds", "extra-app"].some((r) => url === R + r)) return ok(JSON.stringify({ default_branch: "master" }));
    if (url === `${R}compplan/pulls?state=open&per_page=100`)
      return ok(JSON.stringify([
        { head: { ref: "fork-branch", repo: { full_name: "someone/compplan" } } },
        { head: { ref: "compplan_NOV26_github", repo: { full_name: "1903978-prog/compplan" } } },
      ]));
    if (url === `${R}compplan${C}compplan_NOV26_github`) return ok(SAMPLE);
    if (url === `${R}extra-app${C}integration`) return ok(SAMPLE.replace('"project":"compplan"', '"project":"extra"'));
    if (url === `${R}10bonds${C}integration`) return ok("not json");
    if (url.startsWith(`${GH}/search/issues`)) {
      if (url.includes(encodeURIComponent("repo:1903978-prog/compplan "))) return ok(JSON.stringify({ total_count: 27 }));
      if (url.includes(encodeURIComponent("repo:1903978-prog/lm-op-model "))) return ok(JSON.stringify({ total_count: 0 }));
      return { status: 422, text: async () => "{}" };
    }
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

  it("scores each atom by its furthest stage reached in order (0/20/40/55/70/85/100)", () => {
    const base = { implemented: "no", tested: "no", merged: "no", deployed: "no", live_checked: "no", kind: "code", in_progress: "unknown", deliverable_confirmed: "unknown", head_sha: "", tested_sha: "" } as const;
    const p = (o: Partial<Parameters<typeof atomProgress>[0]>) => atomProgress({ ...base, ...o }).percent;
    expect(p({})).toBe(0);
    expect(p({ in_progress: "yes" })).toBe(20);
    expect(p({ implemented: "yes" })).toBe(40);
    expect(p({ implemented: "yes", tested: "yes" })).toBe(55);
    expect(p({ implemented: "yes", tested: "yes", merged: "yes" })).toBe(70);
    expect(p({ implemented: "yes", tested: "yes", merged: "yes", deployed: "yes" })).toBe(85);
    expect(p({ implemented: "yes", tested: "yes", merged: "yes", deployed: "yes", live_checked: "yes" })).toBe(100);
    // A later stage never lifts the bar past an earlier one that is not done or unknown.
    expect(p({ implemented: "yes", tested: "unknown", merged: "yes", deployed: "yes" })).toBe(40);
    // Tests on an older SHA do not count; a matching short SHA does.
    const stale = atomProgress({ ...base, implemented: "yes", tested: "yes", head_sha: "aaaa1111bbbb", tested_sha: "cccc2222" });
    expect(stale).toEqual({ percent: 40, tested_stale: true });
    expect(p({ implemented: "yes", tested: "yes", head_sha: "aaaa1111bbbb", tested_sha: "aaaa1111" })).toBe(55);
    // Non-code: 100% only when the deliverable is confirmed.
    expect(p({ kind: "non-code", live_checked: "yes" })).toBe(0);
    expect(p({ kind: "non-code", in_progress: "yes" })).toBe(20);
    expect(p({ kind: "non-code", deliverable_confirmed: "yes" })).toBe(100);
    expect(labelFor(100, "non-code")).toBe("Deliverable confirmed complete");
    expect(labelFor(40)).toBe("Built on a branch");
  });

  it("averages an action over its atoms and shows the next unfinished one", () => {
    const a = parseLedger("compplan", SAMPLE);
    const byCode = Object.fromEntries(a.actions.map((x) => [x.code, x]));
    // 003A: built, tested on its head SHA, merged = 70; 003B: built only = 40 → average 55.
    expect(byCode.task_compplan_003!.percent).toBe(55);
    expect(byCode.task_compplan_003!.atoms_done).toBe(0);
    expect(byCode.task_compplan_003!.next).toMatchObject({ id: "task_compplan_003B", next_step: "add test" });
    expect(byCode.task_compplan_003!.owner).toBe("Claude");
    expect(byCode.task_compplan_003!.pr).toBe("#931");
    expect(byCode.task_compplan_002!).toMatchObject({ percent: 100, done: true, next: null, stage_label: "Verified live" });
    expect(byCode.task_compplan_001!.percent).toBe(0);
    expect(a.atoms.find((x) => x.id === "task_compplan_003B")!.stage_label).toBe("Built on a branch");
  });

  it("matches the task_athena_059 case: PR open, tests only author-reported → 40%", () => {
    const raw = JSON.stringify({
      atoms: [
        { id: "task_athena_059A", parent: "task_athena_059", original_ask: "Company Research: save completed runs", atom: "runs saved", implemented: "yes", tested: "unknown", merged: "no", deployed: "no", live_checked: "no", pr: "#930", pr_housekeeping: "open draft", evidence: "tests author-reported; database-backed tests not run", next_step: "run database-backed tests on the exact head" },
      ],
    });
    const x = parseLedger("compplan", raw).actions[0]!;
    expect(x).toMatchObject({ code: "task_athena_059", percent: 40, stage_label: "Built on a branch", pr: "#930", done: false });
    expect(x.next!.next_step).toContain("database-backed");
  });

  it("never rounds an unfinished action up to 100%", () => {
    const yes = { implemented: "yes", tested: "yes", merged: "yes", deployed: "yes", live_checked: "yes" };
    const atoms = Array.from({ length: 40 }, (_, i) => ({ id: `t_${i}`, parent: "t", ...yes }));
    atoms[0] = { ...atoms[0]!, live_checked: "no" };
    const x = parseLedger("x", JSON.stringify({ atoms })).actions[0]!;
    expect(x.percent).toBe(99);
    expect(x.done).toBe(false);
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
    expect(v.apps.map((a) => a.openPrs)).toEqual([27, 0, null, null, null]);
    expect(v.apps.map((a) => a.branch)).toEqual(["compplan_NOV26_github", undefined, undefined, "integration", "integration"]);
    // integration first, then the default branch, then the open PR branch; a fork's branch is never tried.
    const tried = calls.filter((c) => c.url.includes("/compplan/contents/")).map((c) => c.url.split("ref=")[1]);
    expect(tried).toEqual(["integration", "master", "compplan_NOV26_github"]);
    expect(v.apps[2]!.message).toContain('GitHub said 404 "Not Found"');
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

  it("shows a pasted snapshot only while the live ledger cannot be read", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    const snap = (repo: string) => ({ repo, label: "Pasted snapshot", groups: [{ group: "001A x", atoms: "1", stages: "✅❌❌❌❌", next_step: "go" }] });
    writeFileSync(join(dir, "nexus-eendigo.json"), JSON.stringify(snap("nexus-eendigo")));
    writeFileSync(join(dir, "compplan.json"), JSON.stringify(snap("compplan")));
    const { f } = fakeGh();
    const v = await loadDelivery({ env: { GITHUB_LEDGER_TOKEN: "t" }, fetcher: f, snapshotDir: dir });
    expect(v.apps.find((a) => a.repo === "nexus-eendigo")!.snapshot!.groups[0]!.stages).toBe("✅❌❌❌❌");
    // compplan's live file was read, so its snapshot is not shown.
    expect(v.apps.find((a) => a.repo === "compplan")!.snapshot).toBeUndefined();
  });

  it("the saved Nexus snapshot matches what Livio pasted", () => {
    const sn = loadSnapshot("nexus-eendigo")!;
    expect(sn.groups).toHaveLength(16);
    // As pasted: the rows add up to 82 while the headline says 84; the page says so instead of correcting it.
    expect(sn.groups.reduce((n, g) => n + Number(g.atoms), 0)).toBe(82);
    expect(sn.check).toContain("82");
    expect(sn.counts).toContain("84 captured");
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
