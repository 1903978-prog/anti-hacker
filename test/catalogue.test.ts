import { describe, it, expect } from "vitest";
import request from "supertest";
import { freshDb } from "./helpers.js";
import { createApp } from "../server/app.js";
import { CATALOGUE, checkReport } from "../server/scan/catalogue.js";
import { saveReport } from "../server/health/report.js";
import type { DB } from "../server/db.js";

const HOST = "compplan.onrender.com";

function addScan(db: DB, id: string, mode: string, at: string, codes: string[]) {
  db.prepare(
    `INSERT INTO scans (id, target, mode, status, started_at, finished_at, findings_count) VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
  ).run(id, HOST, mode, at, at, codes.length);
  for (const code of codes)
    db.prepare(
      `INSERT INTO findings (scan_id, severity, code, title, detail, created_at) VALUES (?, 'low', ?, 't', ?, ?)`,
    ).run(id, code, `detail of ${code}`, at);
}

describe("all-tests catalogue", () => {
  it("lists every real check once, each with a fix", () => {
    const codes = CATALOGUE.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBe(110);
    for (const c of CATALOGUE) expect(c.fix.length).toBeGreaterThan(10);
  });

  it("shows everything as not run before any scan", () => {
    const r = checkReport(freshDb(), HOST);
    expect(r.passed + r.failed).toBe(0);
    expect(r.total).toBe(120); // 110 checks + 10 health criteria
  });

  it("a passive scan fills header/cookie/TLS checks; active-only ones stay not run", () => {
    const db = freshDb();
    addScan(db, "p1", "passive", "2026-10-18T07:00:00Z", ["missing-csp"]);
    const r = checkReport(db, HOST);
    const csp = r.checks.find((c) => c.code === "missing-csp")!;
    expect(csp.status).toBe("fail");
    expect(csp.advice).toMatch(/Content-Security-Policy/);
    expect(csp.detail).toBe("detail of missing-csp");
    expect(r.checks.find((c) => c.code === "missing-hsts")!.status).toBe("pass");
    expect(r.checks.find((c) => c.code === "exposed-git")!.status).toBe("not-run");
    expect(r.passed).toBe(51); // 40 headers + 6 cookies + 6 TLS, minus the one fail
  });

  it("an active scan fills the rest; protected files and login results map to their check", () => {
    const db = freshDb();
    addScan(db, "a1", "active", "2026-10-18T07:00:00Z", ["exposed-env-protected", "no-login-rate-limit"]);
    const r = checkReport(db, HOST);
    const env = r.checks.find((c) => c.code === "exposed-env")!;
    expect(env.status).toBe("fail");
    expect(env.advice).toMatch(/blocked/);
    expect(r.checks.find((c) => c.code === "login-rate-limit")!.status).toBe("fail");
    expect(r.checks.find((c) => c.code === "spf-missing")!.status).toBe("pass");
  });

  it("skips file checks on a catch-all site and login without a login page", () => {
    const db = freshDb();
    addScan(db, "a1", "active", "2026-10-18T07:00:00Z", ["exposed-check-inconclusive"]);
    const r = checkReport(db, HOST);
    expect(r.checks.find((c) => c.code === "exposed-git")!.status).toBe("not-run");
    expect(r.checks.find((c) => c.code === "login-rate-limit")!.status).toBe("not-run");
  });

  it("health report scores become rows with the report's reasons and a recommendation", () => {
    const db = freshDb();
    saveReport(db, HOST, "| Area | Score | Why |\n|---|---|---|\n| Code Quality | 55 | routes.ts is 13,369 lines |\n| Security | 90 | ok |", "t");
    const r = checkReport(db, HOST);
    const code = r.checks.find((c) => c.code === "health-code")!;
    expect(code.status).toBe("fail");
    expect(code.detail).toMatch(/13,369/);
    expect(code.advice).toMatch(/Split/);
    expect(r.checks.find((c) => c.code === "health-security")!.status).toBe("pass");
    expect(r.checks.find((c) => c.code === "health-ux")!.status).toBe("not-run");
  });

  it("serves the list over the API, signed-in only, for known apps only", async () => {
    const app = createApp(freshDb(), { apiToken: "t0ken-for-tests" });
    const auth = { authorization: "Bearer t0ken-for-tests" };
    expect((await request(app).get("/api/tests")).status).toBe(401); // private, like every read
    const list = await request(app).get("/api/tests").set(auth);
    expect(list.body).toContain(HOST);
    const one = await request(app).get("/api/tests/" + HOST).set(auth);
    expect(one.status).toBe(200);
    expect(one.body.checks).toHaveLength(120);
    expect((await request(app).get("/api/tests/evil.example").set(auth)).status).toBe(400);
  });
});
