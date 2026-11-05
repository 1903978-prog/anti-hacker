import type { AppKey } from "./types.js";

export interface AppConfig {
  key: AppKey;
  label: string;
  neonProjectId: string;
  /** Env var holding the READ-ONLY connection string. Never sent to the browser or logged. */
  envVar: string;
}

export const APPS: Record<AppKey, AppConfig> = {
  atlas: { key: "atlas", label: "ATLAS / CompPlan", neonProjectId: "autumn-sun-22098033", envVar: "SECVAL_DBARCH_URL_ATLAS" },
  "lm-op-model": { key: "lm-op-model", label: "LM OpModel", neonProjectId: "long-frog-83686748", envVar: "SECVAL_DBARCH_URL_LM_OP_MODEL" },
  nexus: { key: "nexus", label: "Nexus", neonProjectId: "still-truth-31614363", envVar: "SECVAL_DBARCH_URL_NEXUS" },
};

/** Targets (Livio's brief, 05 Nov 2026): Architecture Quality >= 8.5, Remediation Readiness >= 9. */
export const TARGETS = { architecture: 8.5, readiness: 9 } as const;

/**
 * HISTORICAL MANUAL BASELINES. Supplied by Livio on 05 Nov 2026 and by hand,
 * not measured by secval. Shown as reference only, never as a current score.
 */
export const HISTORICAL_BASELINE = {
  asOf: "2026-11-05",
  source: "Manual provisional assessment supplied by Livio (not an automated measurement)",
  architecture: { atlas: 3.1, "lm-op-model": 6.4, nexus: 6.0 } as Record<AppKey, number>,
  /** Structural counts checked by hand on 05 Nov 2026; used to reconcile the first live scan. */
  metrics: {
    atlas: { tables: 407, primaryKeys: 407, foreignKeys: 3, indexes: 778, idColumnsWithoutFk: 437, rlsTables: 0, branchProtected: false, retentionHours: 6 },
    "lm-op-model": { tables: 192, primaryKeys: 190, foreignKeys: 40, indexes: 326, idColumnsWithoutFk: 57, rlsTables: 0, branchProtected: false, retentionHours: 6 },
    nexus: { tables: 160, primaryKeys: 160, foreignKeys: 123, indexes: 437, idColumnsWithoutFk: 72, rlsTables: 0, branchProtected: false, retentionHours: 6 },
  } as Record<AppKey, Record<string, number | boolean>>,
};

/** Calculation version stamped on every stored score. Bump on ANY change to weights or thresholds. */
export const CALC_VERSION = "dbarch-1.1.0";

/** A result older than this is shown STALE (quick refresh runs every 6h, so 2 missed runs = stale). */
export const STALE_AFTER_MS = 13 * 60 * 60_000;
