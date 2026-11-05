import express, { type Express } from "express";
import { z } from "zod";
import type { DB } from "../db.js";
import { listSpecs } from "./datasets/index.js";
import { resolvePolicy } from "./policy.js";
import { getRun, latestPerDataset, listRuns, validateRefresh } from "./store.js";

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date-time");
const text = z.string().min(1).max(200);

export const submissionSchema = z.object({
  jobId: z.string().min(1).max(100),
  app: text,
  module: text,
  page: text,
  dataset: text,
  datasetCode: z.string().max(100).optional(),
  table: text,
  sourceSystem: text,
  initiator: text,
  kind: z.enum(["external_fetch", "sync", "import", "recompute", "cache", "reload"]),
  startedAt: iso,
  finishedAt: iso,
  operationCompleted: z.boolean(),
  sourceReached: z.boolean().nullable().optional(),
  sourceUnchangedConfirmed: z.boolean().optional(),
  previousSuccessAt: iso.nullable().optional(),
  records: z.array(z.record(z.string(), z.unknown())),
  references: z.record(z.string(), z.array(z.union([z.string(), z.number()]))).optional(),
  authoritative: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  access: z
    .object({ initiatorAuthorized: z.boolean().nullable().optional(), violations: z.array(z.string().max(300)).max(50).optional() })
    .optional(),
  expectedChange: z
    .object({ added: z.number().int().min(0).optional(), removed: z.number().int().min(0).optional(), note: z.string().max(300).optional() })
    .optional(),
});

/** Parses the small JSON bodies as before; the validate route gets its own, larger, authenticated parser. */
export function bigBodyBypass(small: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => (req.path === "/api/quality/validate" ? next() : small(req, res, next));
}

export function qualityRoutes(app: Express, db: DB): void {
  const { policy, error } = resolvePolicy();

  // Called by the apps after every Refresh / Pull / Sync / Import / Reload.
  app.post("/api/quality/validate", express.json({ limit: "12mb" }), (req, res) => {
    const parsed = submissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid submission", issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) });
      return;
    }
    const exists = db.prepare(`SELECT 1 FROM quality_runs WHERE job_id = ?`).get(parsed.data.jobId);
    if (exists) {
      res.status(409).json({ error: "this jobId was already validated" });
      return;
    }
    res.json(validateRefresh(db, parsed.data, policy));
  });

  app.get("/api/quality/summary", (req, res) => {
    res.json(latestPerDataset(db, typeof req.query.app === "string" ? req.query.app : undefined));
  });
  app.get("/api/quality/runs", (req, res) => {
    res.json(
      listRuns(db, {
        app: typeof req.query.app === "string" ? req.query.app : undefined,
        dataset: typeof req.query.dataset === "string" ? req.query.dataset : undefined,
        limit: Number(req.query.limit) || undefined,
      }),
    );
  });
  app.get("/api/quality/runs/:id", (req, res) => {
    const r = getRun(db, Number(req.params.id));
    if (!r) res.status(404).json({ error: "not found" });
    else res.json(r);
  });
  // The documented rules: weights, bands, thresholds and every dataset spec.
  app.get("/api/quality/policy", (_req, res) => {
    res.json({ policy, policyError: error ?? null, datasets: listSpecs() });
  });
}
