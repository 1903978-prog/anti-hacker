import type { DatasetSpec } from "../types.js";

/**
 * lm-op-model (lm-op-model.fly.dev) datasets. Sent by the app at the end of
 * the daily price run and of "Refresh all" (lm-op-model
 * server/lib/secvalQuality.ts). Only bond facts are sent: ISIN, prices,
 * yields, sources and dates; no holdings, amounts or personal data.
 */
const ISIN = "^[A-Z]{2}[A-Z0-9]{9}[0-9]$";

export const LMOP_SPECS: DatasetSpec[] = [
  {
    id: "lm-op-model.bond_quotes",
    app: "lm-op-model",
    title: "Current bond prices (Bonds > Bond database)",
    version: "1",
    keyFields: ["isin"],
    // The app holds prices for several hundred bonds; fewer than 50 priced rows means the run or the table broke.
    minRecords: 50,
    fields: [
      { name: "isin", type: "string", required: true, requiredSeverity: "critical", pattern: ISIN },
      // Price in % of nominal. Above 300 is a yield or a unit read as a price (accreting zero-coupons redeem at most ~250).
      { name: "price", type: "number", required: true, min: 0.01, max: 300 },
      { name: "price_source", type: "string", required: true },
      { name: "price_updated_at", type: "date", required: true },
      // Published yields in %, never derived by the app. Outside -5..60 is a misread page.
      { name: "ytm", type: "number", min: -5, max: 60 },
      { name: "low_52", type: "number", min: 0, max: 300 },
      { name: "high_52", type: "number", min: 0, max: 300 },
    ],
    // Every priced bond must be one the app knows: in the catalogue or in Livio's own holdings.
    refs: [{ field: "isin", reference: "bond_catalogue" }],
    // The price run is daily (weekdays); 30 h leaves room for a late run, a Monday is caught by the decay.
    freshness: { field: "price_updated_at", maxAgeHours: 30 },
    consistency: [{ name: "52-week low not above 52-week high", kind: "lte", a: "low_52", b: "high_52" }],
    provenance: { fields: ["price_source", "price_updated_at"] },
    // Prices change every run, so they are left out of the fingerprint; what is watched is bonds losing their price or a jump in the count.
    change: {
      maxRemovedPct: 5,
      maxChangedPct: 50,
      maxCountJumpPct: 15,
      ignoreFields: ["price", "price_source", "price_updated_at", "ytm", "ytm_source", "low_52", "high_52"],
    },
    notApplicable: {
      accuracy:
        "Prices are read from the market venues during this run; there is no second authoritative copy to compare them with. Implausible prices are caught by the validity ranges here and by the app's own price sanity step.",
    },
  },
  {
    id: "lm-op-model.bond_explorer_bonds",
    app: "lm-op-model",
    title: "Bond catalogue (Bonds > Bond Explorer)",
    version: "1",
    keyFields: ["isin"],
    minRecords: 100,
    fields: [
      { name: "isin", type: "string", required: true, requiredSeverity: "critical", pattern: ISIN },
      { name: "name", type: "string", required: true },
      { name: "currency", type: "string", required: true, pattern: "^[A-Z]{3}$" },
      { name: "type", type: "string", required: true, oneOf: ["government", "corporate"] },
      { name: "coupon", type: "number", min: 0, max: 30 },
      { name: "maturity", type: "date" },
      { name: "issue_date", type: "date" },
      { name: "price", type: "number", min: 0.01, max: 300 },
      { name: "source", type: "string" },
    ],
    provenance: { fields: ["source"] },
    // The catalogue is append-only in the app (bonds are never deleted, only marked); a loss of more than 1% is not normal.
    change: { maxRemovedPct: 1, maxChangedPct: 20, maxCountJumpPct: 25, ignoreFields: ["price"] },
    notApplicable: {
      accuracy: "The catalogue is the app's own record of each bond's terms; there is no second authoritative copy to compare it with in this refresh.",
      referential: "The catalogue is the parent table; other tables link to it, it links to nothing sent here.",
      freshness: "Bond terms (coupon, maturity, issue date) do not age. Price freshness is scored on the bond_quotes dataset.",
      consistency:
        "The only cross-field rule (issue date before maturity) compares dates, which the engine's numeric rules do not cover; maturity and issue date are checked for validity.",
    },
  },
];
