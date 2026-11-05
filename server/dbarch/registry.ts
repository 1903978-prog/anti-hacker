import type { AppKey, Classification } from "./types.js";

/**
 * Human-reviewed knowledge about specific columns. A column is classified
 * ONLY from an entry here (with evidence), never from its `_id` name alone.
 * Everything not listed stays UNVERIFIED. Entries are added by code review
 * after someone inspected the application code; they are not edited at runtime.
 */
export interface Classified {
  /** "table.column" */
  column: string;
  classification: Exclude<Classification, "UNVERIFIED">;
  /** Optional explicit target "table.column" when the name does not reveal it. */
  target?: string;
  evidence: string;
}

export const CLASSIFIED: Record<AppKey, Classified[]> = {
  // Intentionally empty at first release: no column of the three production
  // schemas has been code-inspected yet, so every candidate starts UNVERIFIED.
  atlas: [],
  "lm-op-model": [],
  nexus: [],
};

/** Tables whose integrity matters most (Livio's brief), as name patterns. Used for criticality and for choosing quick checks. */
export const PRIORITY_TABLES: Record<AppKey, RegExp> = {
  atlas: /^(clients?|opportunit(y|ies)|projects?|staff(ing)?|employees?|invoices?|agents?)(_|$)/,
  "lm-op-model": /^(instruments?|isins?|issuers?|quotes?|orders?|positions?|bids?|bid_history|transactions?|financial_transactions?)(_|$)/,
  nexus: /^(projects?|project_members?|task_cards?|tasks?|deliverables?|checklist_items?|approvals?|governance_gates?|gates?|knowledge_cards?|answers?|provenance)(_|$)/,
};
