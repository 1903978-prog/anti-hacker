import { z } from "zod";
import { DIMENSIONS, type DimensionId, type QualityStatus, type Severity } from "./types.js";

/**
 * Central, versioned quality policy. Every number the score depends on lives
 * here, so the score can be reproduced from (submission, spec, policy).
 * Override with SECVAL_DQ_POLICY (JSON, partial); the override is validated
 * and the version string gets a "+override" suffix so a run always says which
 * policy produced it.
 */
export interface QualityPolicy {
  version: string;
  weights: Record<DimensionId, number>;
  /** Lowest score of each band, best first. */
  bands: Array<{ min: number; status: Exclude<QualityStatus, "UNVERIFIED" | "Critical"> }>;
  /** Below the lowest band: "Critical". */
  /** Minimum verified share of the applicable weight to publish a score. */
  minCoverage: number;
  /** A critical failure can never show a score above this. */
  criticalCap: number;
  /** Dimension penalty = 100 x failing share x factor. */
  severityFactor: Record<Severity, number>;
  maxRecords: number;
}

export const DEFAULT_POLICY: QualityPolicy = {
  version: "dq-1.0.0",
  weights: {
    accuracy: 20,
    completeness: 15,
    referential: 15,
    freshness: 10,
    consistency: 10,
    uniqueness: 10,
    validity: 10,
    provenance: 5,
    change: 3,
    access: 2,
  },
  bands: [
    { min: 95, status: "Excellent" },
    { min: 85, status: "Good" },
    { min: 70, status: "Needs Attention" },
    { min: 50, status: "Poor" },
  ],
  minCoverage: 0.8,
  criticalCap: 49,
  severityFactor: { critical: 3, major: 1, minor: 0.4 },
  maxRecords: 50_000,
};

const overrideSchema = z
  .object({
    weights: z.record(z.string(), z.number().min(0).max(100)).optional(),
    bands: z
      .array(z.object({ min: z.number().min(0).max(100), status: z.enum(["Excellent", "Good", "Needs Attention", "Poor"]) }))
      .optional(),
    minCoverage: z.number().min(0).max(1).optional(),
    criticalCap: z.number().min(0).max(100).optional(),
    severityFactor: z
      .object({ critical: z.number().min(0), major: z.number().min(0), minor: z.number().min(0) })
      .partial()
      .optional(),
    maxRecords: z.number().int().min(1).max(500_000).optional(),
  })
  .strict();

/** Resolves the active policy; a bad override is ignored and reported, never half-applied. */
export function resolvePolicy(raw: string | undefined = process.env.SECVAL_DQ_POLICY): {
  policy: QualityPolicy;
  error?: string;
} {
  if (!raw) return { policy: DEFAULT_POLICY };
  try {
    const o = overrideSchema.parse(JSON.parse(raw));
    const weights = { ...DEFAULT_POLICY.weights };
    for (const [k, v] of Object.entries(o.weights ?? {})) {
      if (!(DIMENSIONS as string[]).includes(k)) throw new Error(`unknown dimension ${k}`);
      weights[k as DimensionId] = v;
    }
    const total = DIMENSIONS.reduce((s, d) => s + weights[d], 0);
    if (Math.abs(total - 100) > 1e-9) throw new Error(`weights must sum to 100, got ${total}`);
    const bands = [...(o.bands ?? DEFAULT_POLICY.bands)].sort((a, b) => b.min - a.min);
    const policy: QualityPolicy = {
      version: `${DEFAULT_POLICY.version}+override`,
      weights,
      bands,
      minCoverage: o.minCoverage ?? DEFAULT_POLICY.minCoverage,
      criticalCap: o.criticalCap ?? DEFAULT_POLICY.criticalCap,
      severityFactor: { ...DEFAULT_POLICY.severityFactor, ...o.severityFactor },
      maxRecords: o.maxRecords ?? DEFAULT_POLICY.maxRecords,
    };
    return { policy };
  } catch (err) {
    return { policy: DEFAULT_POLICY, error: `SECVAL_DQ_POLICY ignored: ${(err as Error).message}` };
  }
}
