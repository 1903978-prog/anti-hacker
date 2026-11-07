import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { evaluate } from "../server/quality/engine.js";
import { getSpec } from "../server/quality/datasets/index.js";
import { parseAppTokens } from "../server/middleware.js";
import type { RefreshSubmission, Row } from "../server/quality/types.js";

const ADMIN = "admin-token-123";
const NEXUS = "nexus-quality-token-0123456789abcdef";
const NOW = new Date("2026-11-06T01:05:00Z");

const projects: Row[] = [
  { id: 1, code: "CPL01", practice_area: "pricing", status: "active", start_day: 20300, end_day: 20380, duration_weeks: 12, weekly_meeting_dow: 3, final_meeting_type: "steerco", continues_from_id: null, created_at: "2026-09-01T08:00:00+00:00", updated_at: "2026-11-05T10:00:00+00:00" },
  { id: 2, code: "COE03", practice_area: "coe", status: "closed", start_day: 20200, end_day: 20290, duration_weeks: 10, weekly_meeting_dow: null, final_meeting_type: "final_readout", continues_from_id: null, created_at: "2026-06-01T08:00:00+00:00", updated_at: "2026-10-01T10:00:00+00:00" },
  { id: 3, code: "COE03-X", practice_area: "coe", status: "active", start_day: 20300, end_day: null, duration_weeks: null, weekly_meeting_dow: 1, final_meeting_type: "steerco", continues_from_id: 2, created_at: "2026-10-02T08:00:00+00:00", updated_at: null },
];

function submission(over: Partial<RefreshSubmission> = {}): RefreshSubmission {
  return {
    jobId: `nexus-${Math.random().toString(36).slice(2)}`,
    app: "nexus-eendigo", module: "shadow_refresh", page: "projects", dataset: "nexus-eendigo.projects", table: "public.projects",
    sourceSystem: "neon-master", initiator: "scheduler", kind: "sync",
    startedAt: "2026-11-06T01:00:00Z", finishedAt: "2026-11-06T01:04:00Z",
    operationCompleted: true, sourceReached: true,
    records: projects,
    references: { project_ids: [1, 2, 3] },
    access: { initiatorAuthorized: true },
    ...over,
  };
}

describe("nexus data quality specs", () => {
  it("are registered for the dashboard's app name", () => {
    expect(getSpec("nexus-eendigo.projects")?.app).toBe("nexus-eendigo");
    expect(getSpec("nexus-eendigo.task_cards")?.app).toBe("nexus-eendigo");
  });

  it("score clean project data as a PASS with full coverage of what applies", () => {
    const r = evaluate(getSpec("nexus-eendigo.projects")!, submission(), null, undefined, NOW);
    expect(r.outcome).toBe("PASS");
    // First run: change integrity has no baseline yet (3 of 80 applicable points unverified).
    expect(r.score).toBeGreaterThanOrEqual(95);
    expect(r.dimensions.find((d) => d.id === "accuracy")!.state).toBe("not_applicable");
  });

  it("fail on a broken extension link and on a bad status", () => {
    const bad = [...projects.slice(0, 2), { ...projects[2]!, continues_from_id: 99, status: "paused" }];
    const r = evaluate(getSpec("nexus-eendigo.projects")!, submission({ records: bad }), null, undefined, NOW);
    expect(r.outcome).toBe("FAIL");
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["broken_continues_from_id", "invalid_status"]));
  });

  it("check that tasks point at real projects", () => {
    const tasks: Row[] = [
      { id: 10, project_id: 1, completion_pct: 50, is_mandatory: 0, is_deleted: 0, category: "critical", acceptance_status: "", weight: 1, estimated_minutes: 30, start_day: 20301, deadline_day: 20310, deliverable_id: null, steerco_event_id: null, created_at: "2026-10-01T08:00:00+00:00", updated_at: null },
      { id: 11, project_id: 7, completion_pct: 100, is_mandatory: 1, is_deleted: 0, category: "", acceptance_status: "accepted", weight: 1, estimated_minutes: null, start_day: null, deadline_day: 20310, deliverable_id: null, steerco_event_id: null, created_at: "2026-10-01T08:00:00+00:00", updated_at: null },
    ];
    const r = evaluate(getSpec("nexus-eendigo.task_cards")!, submission({ dataset: "nexus-eendigo.task_cards", table: "public.task_cards", records: tasks, references: { project_ids: [1], deliverable_ids: [], steerco_event_ids: [] } }), null, undefined, NOW);
    expect(r.issues.map((i) => i.code)).toContain("broken_project_id");
  });
});

describe("per-app quality tokens", () => {
  const app = () => createApp(openDb(":memory:"), { apiToken: ADMIN, qualityTokens: `nexus-eendigo=${NEXUS},weak=short` });

  it("ignore short tokens", () => {
    expect([...parseAppTokens(`a=${"x".repeat(24)},b=short,=nokey${"y".repeat(30)}`).keys()]).toEqual(["a"]);
  });

  it("let an app send its own quality checks", async () => {
    const res = await request(app()).post("/api/quality/validate").set({ authorization: `Bearer ${NEXUS}` }).send(submission());
    expect(res.status).toBe(200);
    expect(res.body.dataset).toBe("nexus-eendigo.projects");
  });

  it("refuse another app's dataset", async () => {
    const res = await request(app()).post("/api/quality/validate").set({ authorization: `Bearer ${NEXUS}` })
      .send(submission({ app: "compplan", dataset: "compplan.hubspot_contacts" }));
    expect(res.status).toBe(403);
    const sneaky = await request(app()).post("/api/quality/validate").set({ authorization: `Bearer ${NEXUS}` })
      .send(submission({ dataset: "compplan.hubspot_contacts" }));
    expect(sneaky.status).toBe(403);
  });

  it("open nothing else", async () => {
    const a = app();
    const h = { authorization: `Bearer ${NEXUS}` };
    expect((await request(a).get("/api/quality/summary").set(h)).status).toBe(401);
    expect((await request(a).get("/api/allowlist").set(h)).status).toBe(401);
    expect((await request(a).post("/api/allowlist").set(h).send({ domain: "evil.example" })).status).toBe(401);
  });
});
