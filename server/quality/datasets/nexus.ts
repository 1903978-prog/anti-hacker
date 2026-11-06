import type { DatasetSpec } from "../types.js";

/**
 * NEXUS (nexus-eendigo.fly.dev) datasets. NEXUS sends them once a night, right
 * after its shadow-copy refresh has read the master database (the database
 * may only wake every 6 hours, so the check rides on that refresh).
 *
 * NEXUS sends ids, codes, statuses, numbers and dates only: no names, client
 * names, e-mail addresses or free text. Dates come as day numbers (days since
 * 1970-01-01) so the consistency rules can compare them.
 *
 * `app` is "nexus-eendigo", the first part of the address, so the Health
 * dashboard's Database column picks these checks up.
 */
const DATE_TIME = "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}";
const NO_OUTSIDE_SOURCE =
  "NEXUS is the master store: people type this data into NEXUS itself, so no outside system holds truer values to compare against.";

export const NEXUS_SPECS: DatasetSpec[] = [
  {
    id: "nexus-eendigo.projects",
    app: "nexus-eendigo",
    title: "Projects (Project Guard > Projects)",
    version: "1",
    keyFields: ["code"],
    minRecords: 1,
    fields: [
      { name: "id", type: "integer", required: true, requiredSeverity: "critical", min: 1 },
      { name: "code", type: "string", required: true, requiredSeverity: "critical" },
      { name: "practice_area", type: "string", required: true },
      { name: "status", type: "string", required: true, oneOf: ["active", "closed"] },
      { name: "start_day", type: "integer", min: 0 },
      { name: "end_day", type: "integer", min: 0 },
      { name: "duration_weeks", type: "integer", min: 0, max: 520 },
      { name: "weekly_meeting_dow", type: "integer", min: 1, max: 7 },
      { name: "final_meeting_type", type: "string", oneOf: ["steerco", "final_readout", "none"] },
      { name: "created_at", type: "string", required: true, pattern: DATE_TIME },
      { name: "updated_at", type: "string", pattern: DATE_TIME },
    ],
    // An extension points at the closed project it continues.
    refs: [{ field: "continues_from_id", reference: "project_ids", nullable: true }],
    // Read from the master database during this refresh.
    freshness: { maxAgeHours: 24 },
    consistency: [{ name: "start on or before end", kind: "lte", a: "start_day", b: "end_day", severity: "minor" }],
    provenance: { fields: ["created_at"] },
    // A deleted project is archived and logged first; more than 10% gone in one night is not normal.
    change: { maxRemovedPct: 10, maxChangedPct: 50, maxCountJumpPct: 50, ignoreFields: ["updated_at"] },
    notApplicable: { accuracy: NO_OUTSIDE_SOURCE },
  },
  {
    id: "nexus-eendigo.task_cards",
    app: "nexus-eendigo",
    title: "Project tasks (Activity Plan and Daily Tracking)",
    version: "1",
    keyFields: ["id"],
    minRecords: 1,
    fields: [
      { name: "id", type: "integer", required: true, requiredSeverity: "critical", min: 1 },
      { name: "project_id", type: "integer", required: true, requiredSeverity: "critical" },
      { name: "completion_pct", type: "integer", required: true, min: 0, max: 100 },
      { name: "is_mandatory", type: "integer", oneOf: [0, 1] },
      { name: "is_deleted", type: "integer", oneOf: [0, 1] },
      { name: "category", type: "string", oneOf: ["", "critical", "support"] },
      { name: "acceptance_status", type: "string", oneOf: ["", "requested", "accepted", "rejected"] },
      { name: "weight", type: "integer", min: 0 },
      { name: "estimated_minutes", type: "integer", min: 0 },
      { name: "start_day", type: "integer", min: 0 },
      { name: "deadline_day", type: "integer", min: 0 },
      { name: "created_at", type: "string", required: true, pattern: DATE_TIME },
      { name: "updated_at", type: "string", pattern: DATE_TIME },
    ],
    refs: [
      { field: "project_id", reference: "project_ids" },
      { field: "deliverable_id", reference: "deliverable_ids", nullable: true },
      { field: "steerco_event_id", reference: "steerco_event_ids", nullable: true },
    ],
    freshness: { maxAgeHours: 24 },
    consistency: [{ name: "start on or before deadline", kind: "lte", a: "start_day", b: "deadline_day", severity: "minor" }],
    provenance: { fields: ["created_at"] },
    // Tasks are soft-deleted (is_deleted), so rows only vanish when a whole project is deleted.
    change: { maxRemovedPct: 5, maxChangedPct: 40, maxCountJumpPct: 30, ignoreFields: ["updated_at"] },
    notApplicable: { accuracy: NO_OUTSIDE_SOURCE },
  },
];
