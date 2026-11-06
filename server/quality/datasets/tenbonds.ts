import type { DatasetSpec } from "../types.js";

/**
 * 10bonds.com datasets. 10bonds sends both after it loads a new daily bond copy
 * (its lib/secvalQuality.ts). Dataset ids start with "10bonds." and `app` is
 * "10bonds", so the Health dashboard links them to 10bonds.com.
 */
export const TENBONDS_SPECS: DatasetSpec[] = [
  {
    id: "10bonds.public_bonds",
    app: "10bonds",
    title: "Bond copy (public.public_bonds, rebuilt daily by lm-op-model)",
    version: "1",
    keyFields: ["isin"],
    // The live copy holds thousands of bonds; far fewer means the daily copy broke.
    minRecords: 500,
    fields: [
      { name: "isin", type: "string", required: true, requiredSeverity: "critical", pattern: "^[A-Z]{2}[A-Z0-9]{9}[0-9]$" },
      { name: "name", type: "string", required: true },
      { name: "currency", type: "string", required: true, pattern: "^[A-Z]{3}$" },
      { name: "issuer", type: "string" },
      { name: "coupon", type: "number", min: 0, max: 25 },
      { name: "maturity", type: "date" },
      // Yields in percent. Outside -10 .. 100 is a data error, not a market price.
      { name: "gross_ytm", type: "number", min: -10, max: 100 },
      { name: "modified_duration", type: "number", min: 0, max: 100 },
      { name: "ytm_as_of", type: "date" },
      { name: "years_to_maturity", type: "number" },
    ],
    // Same limit as 10bonds' own daily data watch (lib/dataHealth.ts, STALE_ALERT_DAYS = 4, covers a weekend).
    freshness: { field: "ytm_as_of", maxAgeHours: 96 },
    consistency: [
      // A bond's modified duration can never be longer than the time left until it matures.
      { name: "duration<=years_to_maturity", kind: "lte", a: "modified_duration", b: "years_to_maturity", severity: "minor" },
    ],
    provenance: { fields: ["source", "fetched_at"] },
    // Yields, prices and durations move every day; the identity fields must not.
    change: {
      maxRemovedPct: 5,
      maxChangedPct: 10,
      maxCountJumpPct: 10,
      ignoreFields: ["gross_ytm", "modified_duration", "ytm_as_of", "years_to_maturity", "fetched_at"],
    },
    notApplicable: {
      accuracy:
        "10bonds reads this table directly from the master database (read-only login); it is lm-op-model's own table, not a copy 10bonds made, so there is no second source to compare it with inside 10bonds. Its accuracy against market data belongs to lm-op-model.",
      referential: "A single table of bonds with no link to another table.",
    },
  },
  {
    id: "10bonds.best_bonds",
    app: "10bonds",
    title: "Best bonds per duration and risk step (app.best_bonds, rebuilt from the bond copy)",
    version: "1",
    keyFields: ["duration", "level", "isin"],
    minRecords: 10,
    fields: [
      { name: "duration", type: "number", required: true, min: 0, max: 50 },
      { name: "level", type: "integer", required: true, min: 1, max: 10 },
      { name: "rank", type: "integer", required: true, min: 1, max: 100 },
      { name: "isin", type: "string", required: true, requiredSeverity: "critical", pattern: "^[A-Z]{2}[A-Z0-9]{9}[0-9]$" },
      { name: "gross_ytm", type: "number", required: true, min: -10, max: 100 },
      { name: "modified_duration", type: "number", required: true, min: 0, max: 100 },
      { name: "loss_adjusted_yield", type: "number", required: true },
      { name: "as_of", type: "date", required: true },
    ],
    // Every ranked bond must exist in the bond copy it was built from.
    refs: [{ field: "isin", reference: "public_bonds" }],
    freshness: { field: "as_of", maxAgeHours: 96 },
    consistency: [
      // The ranking yield is the yield minus expected losses, so it can never be above the yield itself.
      { name: "loss_adjusted<=gross_ytm", kind: "lte", a: "loss_adjusted_yield", b: "gross_ytm", severity: "major" },
    ],
    // The stored table must hold the same yield and duration as the bond copy (a stale or corrupted cache shows here).
    accuracy: { fields: ["gross_ytm", "modified_duration"], relTolerance: 0.000001 },
    provenance: { fields: ["source", "as_of"] },
    // A ranking: bonds move in and out of each step's top list every day, so removals are allowed up to 30%.
    change: {
      maxRemovedPct: 30,
      maxChangedPct: 100,
      maxCountJumpPct: 20,
      ignoreFields: ["rank", "gross_ytm", "modified_duration", "loss_adjusted_yield", "as_of"],
    },
  },
];
