import { describe, it, expect } from "vitest";
import request from "supertest";
import { freshDb } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import { engage } from "../server/governance/killswitch.js";
import { guessApp, parseInfra, parseReport, saveReport } from "../server/health/report.js";
import { checkUptime, detectProvider } from "../server/health/uptime.js";
import { dashboard, performanceScore, reliabilityScore } from "../server/health/score.js";
import type { HttpProbe } from "../server/scan/types.js";

const COMPPLAN_REPORT = `Scoring compplan (the app we just shipped).

| Area | Score | Why |
|---|---|---|
| **Data security** | ~82 | Verified live: wrong-password lockout, \`/uploads\` needs login. |
| **Data integrity** | ~80 | Backups now genuinely restore. |
| **Functionality** | ~78 | Live-site checks pass, pages load, nightly CI green. |
| **Solidity** | ~76 | Crash-on-DB-drop fixed. |

And if you meant **lm-op-model** rather than compplan, say so.
(compplan: 0 pending.)`;

async function prove(db: ReturnType<typeof freshDb>, domain: string) {
  const { token } = createChallenge(db, domain, "op")!;
  await verifyOwnership(db, domain, "dns-txt", "op", { resolveTxt: async () => [[token]] });
}

const okProbe: HttpProbe = async () => ({ status: 200, headers: {}, setCookies: [] });
const downProbe: HttpProbe = async () => {
  throw new Error("connect timeout");
};

describe("pasted reports", () => {
  it("reads the scores out of a markdown table", () => {
    const s = parseReport(COMPPLAN_REPORT);
    expect(s.map((x) => [x.area, x.score])).toEqual([
      ["security", 82],
      ["integrity", 80],
      ["functional", 78],
      ["reliability", 76],
    ]);
    expect(s[0]!.evidence).toContain("wrong-password lockout");
  });

  it("reads simple 'Area: score' lines and ignores out-of-range numbers", () => {
    const s = parseReport("Consistency: 70 - same rules everywhere\nSecurity: 140");
    expect(s).toEqual([
      { area: "integrity", label: "Consistency", score: 70, evidence: "same rules everywhere" },
    ]);
  });

  it("maps Livio's 10 criteria names to their areas", () => {
    const text = [
      "Security & Access Control: 90",
      "Data Protection & Privacy: 80",
      "Data Integrity & Consistency: 81",
      "Data Persistence & Recovery: 82",
      "Functional Completeness: 83",
      "User Experience & Interface: 84",
      "Performance & Scalability: 85",
      "Reliability & Error Handling: 86",
      "Code Quality & Maintainability: 87",
      "Deployment & Operational Readiness: 88",
    ].join("\n");
    expect(parseReport(text).map((s) => s.area)).toEqual([
      "security", "privacy", "integrity", "persistence", "functional",
      "ux", "performance", "reliability", "code", "deploy",
    ]);
  });

  it("guesses the app from the text", () => {
    expect(guessApp(freshDb(), COMPPLAN_REPORT)).toBe("compplan.onrender.com");
  });

  it("refuses apps not on the allowlist and text with no scores", () => {
    const db = freshDb();
    expect(saveReport(db, "evil.example", COMPPLAN_REPORT, "op")).toHaveProperty("error");
    expect(saveReport(db, "compplan.onrender.com", "hello", "op")).toHaveProperty("error");
  });

  it("shows pasted scores as estimates on the dashboard", () => {
    const db = freshDb();
    saveReport(db, "compplan.onrender.com", COMPPLAN_REPORT, "op");
    const app = dashboard(db).find((a) => a.host === "compplan.onrender.com")!;
    const sec = app.areas.find((a) => a.key === "security")!;
    expect(sec.measured).toBeNull();
    expect(sec.estimate).toMatchObject({ score: 82, source: "estimate" });
    expect(app.areas).toHaveLength(10);
    expect(app.areas.find((a) => a.key === "privacy")!.estimate).toBeNull();
    expect(app.overall).toBe(79);
  });
});

describe("infrastructure facts", () => {
  const INFRA_TEXT = [
    "Database: Neon Postgres (compplan_prod)",
    "Deploys via: GitHub push to Render",
    "| DB name | compplan_prod |",
    "Usage: 1,200 GitHub Actions minutes",
    "Deployment & Operational Readiness: 88",
  ].join("\n");

  it("reads facts and keeps scores separate", () => {
    expect(parseInfra(INFRA_TEXT).map((f) => [f.key, f.value])).toEqual([
      ["db", "Neon Postgres (compplan_prod)"],
      ["deploy", "GitHub push to Render"],
      ["db", "compplan_prod"],
      ["usage", "1,200 GitHub Actions minutes"],
    ]);
    expect(parseReport(INFRA_TEXT).map((s) => [s.area, s.score])).toEqual([["deploy", 88]]);
  });

  it("shows the host from the address and pasted facts as estimates", () => {
    const db = freshDb();
    saveReport(db, "lm-op-model.fly.dev", INFRA_TEXT, "op");
    const app = dashboard(db).find((a) => a.host === "lm-op-model.fly.dev")!;
    const get = (k: string) => app.infra.find((f) => f.key === k)!;
    expect(get("hosting")).toMatchObject({ value: "Fly.io", source: "measured" });
    expect(get("deploy")).toMatchObject({ value: "GitHub push to Render", source: "estimate" });
    expect(get("repo")).toMatchObject({ value: null, source: null });
  });

  it("recognises the host from response headers", () => {
    expect(detectProvider({ "fly-request-id": "x" })).toBe("Fly.io");
    expect(detectProvider({ "rndr-id": "x" })).toBe("Render");
    expect(detectProvider({})).toBeNull();
  });
});

describe("uptime checks", () => {
  it("never contacts an unproven app", async () => {
    const db = freshDb();
    let called = false;
    const probe: HttpProbe = async (...a) => ((called = true), okProbe(...a));
    expect(await checkUptime(db, "compplan.onrender.com", "t", probe)).toBeNull();
    expect(called).toBe(false);
  });

  it("does nothing while the kill switch is engaged", async () => {
    const db = freshDb();
    await prove(db, "compplan.onrender.com");
    engage(db, "op");
    expect(await checkUptime(db, "compplan.onrender.com", "t", okProbe)).toBeNull();
  });

  it("records up and down checks, which feed measured scores", async () => {
    const db = freshDb();
    await prove(db, "compplan.onrender.com");
    await checkUptime(db, "compplan.onrender.com", "t", okProbe);
    await checkUptime(db, "compplan.onrender.com", "t", okProbe);
    await checkUptime(db, "compplan.onrender.com", "t", okProbe);
    await checkUptime(db, "compplan.onrender.com", "t", downProbe);
    const app = dashboard(db).find((a) => a.host === "compplan.onrender.com")!;
    const fn = app.areas.find((a) => a.key === "reliability")!.measured!;
    expect(fn).toMatchObject({ score: 75, source: "measured" });
    expect(fn.evidence[0]).toContain("3 of 4");
  });

  it("gives no score without evidence", () => {
    expect(reliabilityScore([])).toBeNull();
    expect(performanceScore([])).toBeNull();
  });
});

describe("dashboard API", () => {
  it("needs the token to paste a report, and lists apps without it", async () => {
    const app = createApp(freshDb(), { apiToken: "t0ken" });
    const denied = await request(app)
      .post("/api/dashboard/report")
      .send({ app: "compplan.onrender.com", text: COMPPLAN_REPORT });
    expect(denied.status).toBe(401);

    const saved = await request(app)
      .post("/api/dashboard/report")
      .set("authorization", "Bearer t0ken")
      .send({ app: "compplan.onrender.com", text: COMPPLAN_REPORT });
    expect(saved.status).toBe(201);
    expect(saved.body.scores).toHaveLength(4);

    const dash = await request(app).get("/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.length).toBeGreaterThan(0);
  });
});
