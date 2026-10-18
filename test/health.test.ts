import { describe, it, expect } from "vitest";
import request from "supertest";
import { freshDb } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import { engage } from "../server/governance/killswitch.js";
import { guessApp, parseInfra, parseReport, saveReport, shipperFrom } from "../server/health/report.js";
import { checkUptime, detectProvider } from "../server/health/uptime.js";
import { dashboard, performanceScore, reliabilityScore } from "../server/health/score.js";
import type { HttpProbe } from "../server/scan/types.js";
import { loadReportFiles } from "../server/health/seed.js";
import { addDomain } from "../server/ownership/allowlist.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      ["other", 78],
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
      "Database Design & Structure: 83",
      "User Experience & Interface: 84",
      "Performance & Scalability: 85",
      "Reliability & Error Handling: 86",
      "Code Quality & Maintainability: 87",
      "Deployment & Operational Readiness: 88",
    ].join("\n");
    expect(parseReport(text).map((s) => s.area)).toEqual([
      "security", "privacy", "integrity", "persistence", "database",
      "ux", "performance", "reliability", "code", "deploy",
    ]);
  });

  it("rates the Database criterion but keeps a plain 'Database:' line as a fact", () => {
    const text = [
      "Database: 98 tables in Neon",
      "| # | Criterion | Score | Reason |",
      "|---|---|---|---|",
      "| 5 | Database Design & Structure | 60 | 1 One master database: 10/10 (one Postgres); 2 No duplicated data: 5/10 (two client tables) |",
    ].join("\n");
    expect(parseReport(text).map((s) => [s.area, s.score])).toEqual([["database", 60]]);
    const db = freshDb();
    saveReport(db, "compplan.onrender.com", text, "op");
    const app = dashboard(db).find((a) => a.host === "compplan.onrender.com")!;
    expect(app.areas.find((a) => a.key === "database")!.estimate!.evidence).toEqual([
      "From a pasted report (Database Design & Structure).",
      "1 One master database: 10/10 (one Postgres)",
      "2 No duplicated data: 5/10 (two client tables) ",
    ].map((e) => e.trim()));
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

  it("reads facts (first per kind) and keeps scores separate", () => {
    expect(parseInfra(INFRA_TEXT).map((f) => [f.key, f.value])).toEqual([
      ["db", "Neon Postgres (compplan_prod)"],
      ["deploy", "GitHub push to Render"],
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
    expect(get("shipper")).toMatchObject({ value: "Render (builds on Render)", source: "estimate" });
  });

  it("names who ships it", () => {
    expect(shipperFrom("GitHub Actions workflow runs flyctl deploy")).toBe("GitHub Actions (uses GitHub minutes)");
    expect(shipperFrom("fly deploy from laptop")).toBe("Fly (builds on Fly)");
    expect(shipperFrom("Render auto-deploy on push")).toBe("Render (builds on Render)");
    expect(shipperFrom("by hand")).toBeNull();
    expect(parseInfra("Who ships it: GitHub Actions")[0]).toMatchObject({ key: "shipper" });
  });

  it("recognises the host from response headers", () => {
    expect(detectProvider({ "fly-request-id": "x" })).toBe("Fly.io");
    expect(detectProvider({ "rndr-id": "x" })).toBe("Render");
    expect(detectProvider({})).toBeNull();
  });
});

describe("report files", () => {
  it("reads numbered score tables and ignores other tables", () => {
    const text = [
      "| # | Criterion | Score | Reason |",
      "|---|---|---|---|",
      "| 1 | Security & Access Control | 75 | lockout tested |",
      "| 5 | Functional Completeness | — | not verified |",
      "| 7 | Performance & Scalability | (blank) | not verified |",
      "",
      "| Workflow | Runs | Minutes | Conclusions |",
      "|---|---|---|---|",
      "| Daily DB Backup | 7 | 7.7 | 7 ok |",
      "| Nightly CI | 2 | 5.8 | 1 ok |",
      "",
      "Security: 40",
    ].join("\n");
    expect(parseReport(text).map((s) => [s.area, s.score])).toEqual([["security", 75]]);
    expect(parseInfra(text)).toEqual([]);
  });

  it("names the shipper by the first service mentioned", () => {
    expect(shipperFrom("Render itself on merge (no GitHub workflow deploys)")).toBe("Render (builds on Render)");
    expect(shipperFrom("a session dispatches fly-deploy-slim.yml")).toBe("GitHub Actions (uses GitHub minutes)");
  });

  it("loads the repo's report files once, including secval's own row", () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "reports-"));
    writeFileSync(join(dir, "compplan-health.md"), COMPPLAN_REPORT);
    writeFileSync(join(dir, "secval-health.md"), "Security & Access Control: 70 - token on writes");
    writeFileSync(join(dir, "unknown-health.md"), "Security: 50");
    const first = loadReportFiles(db, dir);
    expect(first.filter((r) => r.loaded).map((r) => r.host)).toEqual([
      "compplan.onrender.com",
      "secval.onrender.com",
    ]);
    expect(loadReportFiles(db, dir).some((r) => r.loaded)).toBe(false);

    const secval = dashboard(db).find((a) => a.host === "secval.onrender.com")!;
    expect(secval.proven).toBe(false);
    expect(secval.areas[0]!.estimate).toMatchObject({ score: 70, source: "estimate" });
  });

  it("puts a report on the proven row when two rows share its name", async () => {
    const db = freshDb();
    addDomain(db, "10bonds.fly.dev", "op");
    const { token } = createChallenge(db, "10bonds.fly.dev", "op")!;
    await verifyOwnership(db, "10bonds.fly.dev", "dns-txt", "op", { resolveTxt: async () => [[token]] });
    const dir = mkdtempSync(join(tmpdir(), "reports-"));
    writeFileSync(join(dir, "10bonds-health.md"), "Security & Access Control: 70 - headers");
    expect(loadReportFiles(db, dir).filter((r) => r.loaded).map((r) => r.host)).toEqual(["10bonds.fly.dev"]);
  });

  it("never checks a report-only app", async () => {
    const db = freshDb();
    let called = false;
    const probe: HttpProbe = async (...a) => ((called = true), okProbe(...a));
    expect(await checkUptime(db, "secval.onrender.com", "t", probe)).toBeNull();
    expect(called).toBe(false);
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

    const dash = await request(app).get("/api/dashboard").set("authorization", "Bearer t0ken");
    expect(dash.status).toBe(200);
    expect(dash.body.length).toBeGreaterThan(0);
  });
});
