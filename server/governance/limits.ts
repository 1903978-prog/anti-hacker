import { z } from "zod";

/**
 * Hard resource caps the policy engine applies to every scan. These are
 * ceilings: a scan may request limits at or below these, never above. The
 * default profile also forbids any data-mutating request.
 */
export interface ResourceLimits {
  maxRequestsPerSecond: number;
  maxTotalRequests: number;
  maxRuntimeMs: number;
  maxRetainedBytes: number;
  allowDataMutating: boolean;
}

/** The ceilings. No requested scan limit may exceed these. */
export const HARD_CAPS: ResourceLimits = {
  maxRequestsPerSecond: 5,
  maxTotalRequests: 500,
  maxRuntimeMs: 2 * 60 * 1000, // 2 minutes
  maxRetainedBytes: 2 * 1024 * 1024, // 2 MB of findings metadata
  allowDataMutating: false,
};

/** The conservative default applied when a scan requests nothing specific. */
export const DEFAULT_LIMITS: ResourceLimits = {
  maxRequestsPerSecond: 2,
  maxTotalRequests: 100,
  maxRuntimeMs: 60 * 1000, // 1 minute
  maxRetainedBytes: 512 * 1024, // 512 KB
  allowDataMutating: false,
};

export const requestedLimitsSchema = z
  .object({
    maxRequestsPerSecond: z.number().int().positive().optional(),
    maxTotalRequests: z.number().int().positive().optional(),
    maxRuntimeMs: z.number().int().positive().optional(),
    maxRetainedBytes: z.number().int().positive().optional(),
    allowDataMutating: z.boolean().optional(),
  })
  .strict();

export type RequestedLimits = z.infer<typeof requestedLimitsSchema>;

export interface LimitCheck {
  ok: boolean;
  reason?: string;
  effective: ResourceLimits;
}

/**
 * Validates a scan's requested limits against the hard caps and merges them
 * onto the conservative default. Any request above a cap fails the check.
 * Enabling data-mutating operations is never permitted (caps forbid it).
 */
export function resolveLimits(requested?: RequestedLimits): LimitCheck {
  const req = requested ?? {};
  const effective: ResourceLimits = { ...DEFAULT_LIMITS };

  const numeric: Array<keyof Omit<ResourceLimits, "allowDataMutating">> = [
    "maxRequestsPerSecond",
    "maxTotalRequests",
    "maxRuntimeMs",
    "maxRetainedBytes",
  ];

  for (const key of numeric) {
    const value = req[key];
    if (value === undefined) continue;
    if (value > HARD_CAPS[key]) {
      return {
        ok: false,
        reason: `${key} ${value} exceeds hard cap ${HARD_CAPS[key]}`,
        effective,
      };
    }
    effective[key] = value;
  }

  if (req.allowDataMutating === true && !HARD_CAPS.allowDataMutating) {
    return {
      ok: false,
      reason: "data-mutating operations are not permitted",
      effective,
    };
  }
  effective.allowDataMutating = false;

  return { ok: true, effective };
}
