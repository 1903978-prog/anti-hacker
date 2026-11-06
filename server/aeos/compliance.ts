/**
 * AEOS compliance view: reads the file `reports/aeos-compliance.json` that
 * `scripts/aeos/collect.py` writes (it runs each enrolled repository's own
 * validation and tests and reads its .engineering/ state), checks its shape
 * and tells the page whether it can be trusted.
 *
 * Read-only and local: no network call, no write, nothing about any scan
 * target. It is not scanning, so it does not go through the scan policy
 * engine (same as the usage counters). It is NOT real-time: the page shows
 * the date the collector ran, flags data older than STALE_AFTER_DAYS, and
 * says how to refresh it. A missing or invalid file is reported as such,
 * never turned into zeros or a fake "all good".
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const STALE_AFTER_DAYS = 7;

const githubUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://github.com/"), "pull request link must be a github.com address");

const prSchema = z
  .object({
    number: z.number().optional(),
    html_url: githubUrl,
    state: z.string(),
    draft: z.boolean(),
    mergeable_state: z.string().optional(),
    head_sha: z.string().optional(),
  })
  .passthrough();

const appSchema = z
  .object({
    application: z.string().min(1),
    installed: z.boolean(),
    score: z.number().min(0).max(100),
    status: z.string().optional(),
    repository: z.string().optional(),
    aeos_version: z.string().nullable().optional(),
    branch: z.string().optional(),
    head: z.string().optional(),
    validate: z.object({ ok: z.boolean(), output: z.array(z.string()).optional() }).optional(),
    own_tests: z.object({ ran: z.number(), ok: z.boolean() }).optional(),
    backlog: z
      .object({
        total: z.number(),
        verified: z.number(),
        unverified: z.number(),
        open_p0_p1: z.number(),
        by_status: z.record(z.string(), z.number()).optional(),
      })
      .optional(),
    open_blockers: z.number().optional(),
    last_checkpoint: z.string().nullable().optional(),
    releases_recorded: z.number().optional(),
    release_restrictions: z.number().optional(),
    verified_config_facts: z.number().optional(),
    unverified_items: z.array(z.string()).optional(),
    pr: prSchema.nullable().optional(),
    fresh_session: z
      .object({ passed: z.number(), total: z.number(), evidence: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
    outstanding_approvals: z.array(z.string()).optional(),
    release_readiness: z.string().optional(),
    score_parts: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

const fileSchema = z.object({
  schema: z.literal(1),
  collected_at: z.string().datetime(),
  collector: z.string(),
  realtime: z.literal(false),
  refresh: z.string(),
  score_basis: z.record(z.string(), z.number()),
  apps: z.array(appSchema).min(1),
});

export type ComplianceApp = z.infer<typeof appSchema>;

export interface ComplianceSummary {
  apps: number;
  installed: number;
  validationOk: number;
  testsPassing: number;
  averageScore: number;
  openP0P1: number;
  verifiedTasks: number;
  unverifiedTasks: number;
  unverifiedItems: number;
  outstandingApprovals: number;
}

export interface ComplianceReport {
  /** ok: fresh data; stale: older than STALE_AFTER_DAYS; no-data: file missing; invalid: file unreadable or wrong shape. */
  status: "ok" | "stale" | "no-data" | "invalid";
  collectedAt?: string;
  ageDays?: number;
  realtime: false;
  refresh: string;
  scoreBasis?: Record<string, number>;
  apps?: ComplianceApp[];
  summary?: ComplianceSummary;
  error?: string;
}

const HOW_TO_REFRESH =
  "Run `python3 scripts/aeos/collect.py --manifest <manifest.json> --out reports/aeos-compliance.json`; nothing refreshes it by itself.";

export function summarise(apps: ComplianceApp[]): ComplianceSummary {
  const sum = (f: (a: ComplianceApp) => number) => apps.reduce((n, a) => n + f(a), 0);
  return {
    apps: apps.length,
    installed: apps.filter((a) => a.installed).length,
    validationOk: apps.filter((a) => a.validate?.ok === true).length,
    testsPassing: apps.filter((a) => a.own_tests?.ok === true).length,
    averageScore: apps.length ? Math.round(sum((a) => a.score) / apps.length) : 0,
    openP0P1: sum((a) => a.backlog?.open_p0_p1 ?? 0),
    verifiedTasks: sum((a) => a.backlog?.verified ?? 0),
    unverifiedTasks: sum((a) => a.backlog?.unverified ?? 0),
    unverifiedItems: sum((a) => a.unverified_items?.length ?? 0),
    outstandingApprovals: sum((a) => a.outstanding_approvals?.length ?? 0),
  };
}

export function loadCompliance(file: string, now: Date = new Date()): ComplianceReport {
  const base = { realtime: false as const, refresh: HOW_TO_REFRESH };
  if (!existsSync(file)) {
    return { ...base, status: "no-data", error: "No AEOS compliance data has been collected yet." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ...base, status: "invalid", error: "The compliance file is not valid JSON." };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ...base,
      status: "invalid",
      error: `The compliance file has the wrong shape at ${first?.path.join(".") || "top level"}: ${first?.message ?? "invalid"}.`,
    };
  }
  const d = parsed.data;
  const ageDays = Math.max(0, (now.getTime() - new Date(d.collected_at).getTime()) / 86_400_000);
  return {
    ...base,
    status: ageDays > STALE_AFTER_DAYS ? "stale" : "ok",
    collectedAt: d.collected_at,
    ageDays: Math.round(ageDays * 10) / 10,
    refresh: d.refresh || HOW_TO_REFRESH,
    scoreBasis: d.score_basis,
    apps: d.apps,
    summary: summarise(d.apps),
  };
}
