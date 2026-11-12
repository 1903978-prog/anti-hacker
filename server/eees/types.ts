/**
 * EEES v1.0 (Eendigo Engineering Excellence Standard) file formats.
 *
 * The standard itself lives in eees/v1.0/criteria.json (30 dimensions,
 * weights, checks, ceilings, gates). Each app's evidence lives in
 * eees/evidence/<app>.json. These schemas are the single definition of both
 * formats; scripts/eees/schema.ts exports them as JSON Schema for apps that
 * are not written in TypeScript.
 */
import { z } from "zod";

export const LEVELS = ["synthetic", "prodlike", "production", "independent-sustained"] as const;
export type Level = (typeof LEVELS)[number];

export const CHECK_STATUS = ["verified", "failed", "unknown", "na"] as const;
export type CheckStatus = (typeof CHECK_STATUS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "date must be YYYY-MM-DD or an ISO time");

export const checkDefSchema = z.object({
  id: z.string().regex(/^D\d{2}\.\d+$/),
  title: z.string().min(1),
  acceptance: z.string().min(1),
  method: z.enum(["automated", "read-only-query", "test-run", "browser", "drill", "review", "telemetry"]),
  cadence: z.enum(["daily", "weekly", "monthly", "per-release"]),
  references: z.array(z.string()),
  collector: z.string().optional(),
  secvalSignal: z.string().optional(),
  flowDerived: z.boolean().optional(),
  /** A failed check of this kind is a release-blocking finding (feeds G1/G2 when the app says so). */
  critical: z.enum(["security", "financial", "recovery", "governance"]).optional(),
});
export type CheckDef = z.infer<typeof checkDefSchema>;

export const criteriaSchema = z.object({
  standard: z.literal("EEES"),
  version: z.string(),
  title: z.string(),
  adopted: isoDate,
  approvedBy: z.string(),
  domains: z.array(z.object({ id: z.string(), name: z.string(), weight: z.number() })),
  dimensions: z.array(
    z.object({
      id: z.string().regex(/^D\d{2}$/),
      n: z.number().int(),
      domain: z.string(),
      name: z.string(),
      weight: z.number().positive(),
      definitionOf10: z.string().min(1),
      checks: z.array(checkDefSchema).min(1),
    }),
  ),
  evidenceLevels: z.array(z.object({ id: z.enum(LEVELS), ceiling: z.number(), meaning: z.string() })),
  scoreBands: z.array(z.object({ min: z.number(), max: z.number(), meaning: z.string() })),
  hardGates: z.array(
    z.object({
      id: z.string(),
      cap: z.number(),
      blocksRelease: z.boolean(),
      trigger: z.enum(["presence", "absence"]),
      text: z.string(),
    }),
  ),
  releaseGates: z.array(z.object({ id: z.string(), text: z.string() })),
  cadences: z.record(z.string(), z.number()),
  tiers: z.array(z.object({ id: z.string(), esiiWeight: z.number(), meaning: z.string() })),
});
export type Criteria = z.infer<typeof criteriaSchema>;

export const evidenceItemSchema = z.object({
  /** Where the proof is: repo path, project file, PR, CI run or query file. */
  link: z.string().min(1),
  /** agent-claim = a coding agent said so. It never counts as verification. */
  kind: z.enum(["measurement", "test-run", "ci-run", "review", "drill", "telemetry", "agent-claim"]),
  date: isoDate,
  environment: z.enum(["production", "prodlike", "test", "repository"]),
  reviewer: z.string().optional(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const checkResultSchema = z.object({
  status: z.enum(CHECK_STATUS),
  level: z.enum(LEVELS).optional(),
  evidence: z.array(evidenceItemSchema).default([]),
  note: z.string().optional(),
  /** Required for status "na". */
  justification: z.string().optional(),
  /** Required for status "na" and for level "independent-sustained". */
  reviewer: z.string().optional(),
  effort: z.string().optional(),
  risk: z.string().optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const gateStateSchema = z.object({
  status: z.enum(["pass", "fail", "unknown"]),
  note: z.string().optional(),
  evidence: z.array(evidenceItemSchema).default([]),
});

export const defectSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  category: z.enum(["security", "data", "financial", "recovery", "governance", "functional", "reliability", "other"]),
  /** open = present in production; fixed-unreleased = fixed on a branch, still in production; closed-verified = fix verified live. */
  status: z.enum(["open", "fixed-unreleased", "closed-verified"]),
  /** A P0 security defect only triggers gate G1 when it is confirmed exploitable. */
  exploitable: z.boolean().optional(),
  /** A P1 only triggers G3 when material (default true). */
  material: z.boolean().optional(),
  dimensions: z.array(z.string().regex(/^D\d{2}$/)).default([]),
  link: z.string().optional(),
  owner: z.string().optional(),
  impact: z.string().optional(),
  effort: z.string().optional(),
  risk: z.string().optional(),
});
export type Defect = z.infer<typeof defectSchema>;

export const evidenceFileSchema = z.object({
  standard: z.literal("EEES"),
  standardVersion: z.string(),
  app: z.string(),
  assessedAt: isoDate,
  assessor: z.string(),
  productionVersion: z
    .object({ sha: z.string().nullable(), source: z.string(), checkedAt: isoDate })
    .nullable()
    .default(null),
  lastIndependentVerification: isoDate.nullable().default(null),
  checks: z.record(z.string().regex(/^D\d{2}\.\d+$/), checkResultSchema).default({}),
  dimensionsNA: z
    .record(z.string().regex(/^D\d{2}$/), z.object({ justification: z.string().min(1), reviewer: z.string().min(1) }))
    .default({}),
  gates: z.record(z.string().regex(/^G\d$/), gateStateSchema).default({}),
  releaseGates: z.record(z.string(), gateStateSchema).default({}),
  defects: z.array(defectSchema).default([]),
  defectRegister: z
    .object({ link: z.string(), counts: z.record(z.string(), z.number()), note: z.string().optional() })
    .optional(),
  history: z
    .array(z.object({ date: isoDate, assured: z.number(), raw: z.number(), coverage: z.number(), standardVersion: z.string() }))
    .default([]),
  notes: z.array(z.string()).default([]),
});
export type EvidenceFile = z.infer<typeof evidenceFileSchema>;

export const appsSchema = z.object({
  standardVersion: z.string(),
  updated: isoDate,
  note: z.string().optional(),
  apps: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      name: z.string(),
      kind: z.enum(["application", "subsystem", "infrastructure"]),
      parent: z.string().optional(),
      tier: z.enum(["critical", "standard", "public"]),
      owner: z.string(),
      repo: z.string().nullable(),
      hosts: z.array(z.string()),
      deploy: z.string().optional(),
      evidence: z.string(),
    }),
  ),
});
export type AppsFile = z.infer<typeof appsSchema>;
export type AppEntry = AppsFile["apps"][number];

export const flowsSchema = z.object({
  standardVersion: z.string(),
  updated: isoDate,
  source: z.string().optional(),
  requiredFields: z.array(z.string()),
  flows: z.array(
    z
      .object({
        id: z.string(),
        name: z.string(),
        producer: z.string(),
        consumer: z.string(),
        critical: z.boolean(),
        status: z.enum(["healthy", "failing", "unknown"]),
        measuredAt: isoDate,
        evidence: z.string(),
      })
      .catchall(z.unknown()),
  ),
});
export type FlowsFile = z.infer<typeof flowsSchema>;
export type Flow = FlowsFile["flows"][number];
