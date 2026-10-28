import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { dashboard } from "../server/health/score.js";
import { fetchCiSignal, type CiFetcher } from "../server/health/ci.js";
import { saveReport } from "../server/health/report.js";

const run = (name: string, conclusion: string, event = "push") => ({
  name, conclusion, event, html_url: `https://github.com/1903978-prog/10bonds/actions/runs/${name}`, updated_at: "2026-10-28T05:00:00Z",
});

function fake(runs: unknown[], status = 200): CiFetcher {
  return async (url) =>
    url.includes("/actions/runs")
      ? { status, json: async () => ({ workflow_runs: runs }) }
      : { status: 200, json: async () => ({ default_branch: "main" }) };
}

describe("live build signals", () => {
  it("uses the newest finished run of each workflow and ignores PR and cancelled runs", async () => {
    const s = await fetchCiSignal("10bonds.com", fake([
      run("Deploy", "failure"),
      run("Deploy", "success"), // older, ignored
      run("Link check", "success"),
      run("Link check", "failure"), // older, ignored
      run("Checks", "failure", "pull_request"),
      run("Nightly", "cancelled"),
    ]));
    expect(s!.failing.map((f) => f.name)).toEqual(["Deploy"]);
    expect(s!.branch).toBe("main");
  });

  it("gives no signal for unknown apps or unreadable repos", async () => {
    expect(await fetchCiSignal("example.com", fake([]))).toBeNull();
    expect(await fetchCiSignal("10bonds.com", fake([], 404))).toBeNull();
  });

  it("caps Reliability and Deploy at 50 and marks them failing now", () => {
    const db = freshDb();
    saveReport(db, "10bonds.com", "Reliability & Error Handling: 85 - fine\nDeployment & Operational Readiness: 88 - fine\nCode Quality: 88 - fine", "t");
    const ci = () => ({ repo: "10bonds", branch: "main", checkedAt: "2026-10-28T05:10:00Z", failing: [{ name: "Deploy", url: "https://x/run/1", at: "" }] });
    const app = dashboard(db, new Date(), ci).find((a) => a.host === "10bonds.com")!;
    const get = (k: string) => app.areas.find((a) => a.key === k)!;
    expect(get("deploy").measured).toMatchObject({ score: 50, source: "measured", failingNow: [{ name: "Deploy", url: "https://x/run/1" }] });
    expect(get("reliability").measured!.score).toBe(50);
    expect(get("deploy").measured!.evidence.join(" ")).toContain("Before the cap: 88");
    expect(get("code").measured).toBeNull();
    const green = dashboard(db, new Date(), () => null).find((a) => a.host === "10bonds.com")!;
    expect(green.areas.find((a) => a.key === "deploy")!.measured).toBeNull();
  });
});
