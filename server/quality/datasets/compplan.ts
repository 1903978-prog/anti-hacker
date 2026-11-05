import type { DatasetSpec } from "../types.js";

/**
 * Eendigo ATLAS / compplan datasets. Add one entry per refreshable table; the
 * rules below are the written definition of "good data" for that table.
 */
export const COMPPLAN_SPECS: DatasetSpec[] = [
  {
    id: "compplan.hubspot_contacts",
    app: "compplan",
    title: "HubSpot contacts (Business Development > Contacts)",
    version: "1",
    keyFields: ["hubspot_id"],
    minRecords: 1,
    fields: [
      { name: "hubspot_id", type: "string", required: true, requiredSeverity: "critical" },
      { name: "email", type: "string", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
      { name: "synced_at", type: "date", required: true },
      { name: "created_at", type: "date", required: true },
      { name: "updated_at", type: "date", required: true },
    ],
    // company_hubspot_id is optional; when set it must exist in hubspot_companies.
    refs: [{ field: "company_hubspot_id", reference: "hubspot_companies", nullable: true }],
    // The page is fetched from HubSpot during this refresh; no per-row freshness column exists.
    freshness: { maxAgeHours: 24 },
    provenance: { fields: ["hubspot_id", "synced_at"] },
    // The sync only proposes changes and never deletes: a loss of more than 2% of contacts is not normal.
    change: { maxRemovedPct: 2, maxChangedPct: 10, maxCountJumpPct: 10, ignoreFields: ["updated_at", "synced_at"] },
    notApplicable: {
      consistency: "The contacts table has no numeric or cross-field relationship; links to other tables are covered by referential integrity.",
    },
    // Accuracy is measured on the HubSpot page fetched in this refresh (a sample of up to 100 contacts, the last page of the sync): each non-empty HubSpot value must equal the stored value. A pending proposal in the app is therefore counted as a mismatch until the user accepts or rejects it.
    accuracy: { fields: ["first_name", "last_name", "email", "phone", "job_title", "company", "city", "country", "lifecycle_stage", "lead_status"] },
  },
];
