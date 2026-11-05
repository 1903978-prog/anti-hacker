import type { Catalog, CheckResult, CriterionScore, FkCandidate, NeonSettings, SubScore, VerifyState } from "./types.js";

/**
 * Deterministic scoring. Rules that apply everywhere:
 *  - criterion score = 10 x points earned / points possible;
 *  - an input that could not be measured earns 0 AND lowers coverage, so
 *    missing evidence can never raise a score;
 *  - coverage 1 = VERIFIED, 0.5..<1 = PARTIAL (score shown with its coverage),
 *    below 0.5 = UNVERIFIED (score is N/V, shown as null).
 * Change any weight or threshold below only together with CALC_VERSION.
 */

export const ARCH_WEIGHTS: Array<{ key: string; label: string; weight: number }> = [
  { key: "pk", label: "Primary-key coverage", weight: 12 },
  { key: "fk", label: "Foreign-key integrity", weight: 14 },
  { key: "orphans", label: "Orphan and invalid-reference rates", weight: 14 },
  { key: "constraints", label: "Unique and CHECK constraints", weight: 8 },
  { key: "security", label: "Security and authorization", weight: 10 },
  { key: "indexing", label: "Indexing and performance", weight: 10 },
  { key: "migrations", label: "Migration governance", weight: 8 },
  { key: "backup", label: "Backup and recovery", weight: 10 },
  { key: "audit", label: "Auditability and history", weight: 7 },
  { key: "maintain", label: "Maintainability and scalability", weight: 7 },
];

export interface Attestations {
  /** Human-reviewed 0-10 for "app-layer authorization reviewed" (replaces nothing; adds measured-by-human evidence). */
  authzReview: number | null;
  /** Restore test evidence, 0-10. */
  restoreTest: number | null;
  /** Someone independent re-verified the readiness deliverables. */
  independentlyVerified: boolean;
}

export type SchemaChange = "first" | "unchanged" | "changed" | "approved";

export interface Evidence {
  cat: Catalog | null;
  inventory: FkCandidate[];
  checksDefined: number;
  checks: CheckResult[];
  neon: NeonSettings | null;
  schemaChange: SchemaChange;
  deepAuditAgeHours: number | null;
  attest: Attestations;
  recommendationsTotal: number;
  recommendationsComplete: number;
  draftsTotal: number;
  draftsSafe: number;
  needsMigration: number;
  hasPrevious: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function sub(key: string, label: string, max: number, earned: number | null, calculation: string, inputs: SubScore["inputs"], source: string): SubScore {
  return { key, label, max, earned: earned === null ? null : r2(clamp(earned, 0, max)), calculation, inputs, source };
}

function roll(key: string, label: string, weight: number, subs: SubScore[], open: string[] = [], cap?: { max: number; reason: string }): CriterionScore {
  const possible = subs.reduce((a, s) => a + s.max, 0);
  const measured = subs.filter((s) => s.earned !== null).reduce((a, s) => a + s.max, 0);
  const earned = subs.reduce((a, s) => a + (s.earned ?? 0), 0);
  const coverage = possible ? measured / possible : 0;
  let score: number | null = coverage < 0.5 ? null : r2((10 * earned) / possible);
  let capReason: string | undefined;
  if (score !== null && cap && score > cap.max) { score = cap.max; capReason = cap.reason; }
  const state: VerifyState = coverage >= 1 ? "VERIFIED" : coverage >= 0.5 ? "PARTIAL" : "UNVERIFIED";
  return { key, label, weight, score, coverage: r2(coverage), state, subscores: subs, open: [...open, ...subs.filter((s) => s.earned === null).map((s) => `Not measured: ${s.label}`)], ...(capReason ? { capReason } : {}) };
}

const SRC = "pg_catalog / information_schema (public schema)";

export function scoreArchitecture(ev: Evidence): CriterionScore[] {
  const cat = ev.cat;
  const W = Object.fromEntries(ARCH_WEIGHTS.map((w) => [w.key, w]));
  const mk = (k: string, subs: SubScore[], open?: string[], cap?: { max: number; reason: string }) => roll(k, W[k]!.label, W[k]!.weight, subs, open, cap);

  if (!cat) {
    return ARCH_WEIGHTS.map((w) => roll(w.key, w.label, w.weight, [sub("all", "Catalog unavailable", 10, null, "No catalog collected", {}, "none")]));
  }
  const nT = cat.tables.length;
  const withPk = cat.tables.filter((t) => t.hasPrimaryKey).length;
  const declared = cat.foreignKeys.length;
  const confirmedMissing = ev.inventory.filter((c) => c.classification === "mandatory" || c.classification === "optional").length;
  const unclassified = ev.inventory.filter((c) => c.classification === "UNVERIFIED").length;
  const fkDen = declared + confirmedMissing + 0.5 * unclassified;

  const ran = ev.checks.filter((c) => c.outcome === "PASS" || c.outcome === "FAIL" || c.outcome === "UNVERIFIED");
  const decisive = ev.checks.filter((c) => c.outcome === "PASS" || c.outcome === "FAIL");
  const fails = ev.checks.filter((c) => c.outcome === "FAIL");
  const failRows = fails.reduce((a, c) => a + (c.failures ?? 0), 0);
  const examinedRows = decisive.reduce((a, c) => a + (c.rowsExamined ?? 0), 0);
  const orphanRate = examinedRows ? failRows / examinedRows : 0;
  const hasCritical = fails.some((c) => c.severity === "P0");

  const uniq = new Set(cat.constraints.map((c) => c.table));
  for (const i of cat.indexes) if (i.unique && !i.primary) uniq.add(i.table);
  const tablesWithRule = cat.tables.filter((t) => uniq.has(t.name)).length;

  const fkIdx = cat.foreignKeys.filter((f) => cat.indexes.some((i) => i.table === f.table && f.columns.every((c, n) => i.columns[n] === c))).length;
  const dupKeys = new Map<string, number>();
  for (const i of cat.indexes) { const k = `${i.table}|${i.columns.join(",")}|${i.unique}`; dupKeys.set(k, (dupKeys.get(k) ?? 0) + 1); }
  const dupIdx = [...dupKeys.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0);
  const invalidIdx = cat.indexes.filter((i) => !i.valid).length;

  const auditTables = cat.tables.filter((t) => /(^|_)(audit|history|log|logs|versions?|revisions?|events?)(_|$)/.test(t.name));
  const auditTriggerTables = new Set(cat.triggers.map((t) => t.table));
  const tsTables = cat.tables.filter((t) => t.columns.some((c) => /^(created_at|createdat|inserted_at)$/i.test(c))).length;

  const wide = cat.tables.filter((t) => t.columns.length > 60).length;
  const snake = cat.columns.filter((c) => /^[a-z][a-z0-9_]*$/.test(c.name)).length;
  const bigUnindexed = cat.tables.filter((t) => t.estRows > 100_000 && !cat.indexes.some((i) => i.table === t.name && !i.primary)).length;

  const neon = ev.neon;
  const retH = neon?.historyRetentionSeconds != null ? neon.historyRetentionSeconds / 3600 : null;

  return [
    mk("pk", [sub("pk_ratio", "Tables with a primary key", 10, nT ? (10 * withPk) / nT : null, "10 x tablesWithPK / tables", { tables: nT, withPk }, SRC)]),
    mk(
      "fk",
      [sub("fk_cover", "Declared FKs against candidate relationships", 10, nT ? (fkDen ? (10 * declared) / fkDen : 10) : null,
        "10 x declared / (declared + classified-missing + 0.5 x unclassified candidates). External or intentionally non-FK columns are excluded.",
        { declared, classifiedMissing: confirmedMissing, unclassifiedCandidates: unclassified }, `${SRC} + registry`)],
      unclassified ? [`${unclassified} candidate column(s) still need classification from code inspection`] : [],
    ),
    mk(
      "orphans",
      [
        sub("orphan_clean", "Orphan rate in executed checks", 6, decisive.length ? 6 * (1 - clamp(orphanRate * 20, 0, 1)) : null,
          "6 x (1 - min(1, 20 x failedRows/rowsExamined)); any failed P0 check caps the criterion at 4",
          { checksDecisive: decisive.length, failedRows: failRows, rowsExamined: examinedRows }, "read-only aggregate checks"),
        sub("orphan_cover", "Candidate relationships verified", 4, ev.inventory.length || declared ? (ev.inventory.length ? (4 * ran.length) / ev.inventory.length : 4) : null,
          "4 x checksRun / candidate relationships", { checksRun: ran.length, candidates: ev.inventory.length, checksDefined: ev.checksDefined }, "read-only aggregate checks"),
      ],
      [],
      hasCritical ? { max: 4, reason: "A verified P0 orphan check failed" } : undefined,
    ),
    mk("constraints", [sub("rules", "Tables with a UNIQUE or CHECK rule", 10, nT ? 10 * clamp(tablesWithRule / (0.5 * nT), 0, 1) : null,
      "10 x min(1, tablesWithRule / (50% of tables))", { tables: nT, tablesWithRule }, SRC)]),
    mk(
      "security",
      [
        sub("public_grants", "No table privileges granted to PUBLIC", 4, 4 * (1 - clamp(cat.publicGrantTables.length / Math.max(1, nT), 0, 1)),
          "4 x (1 - tablesGrantedToPublic / tables)", { publicGrantTables: cat.publicGrantTables.length, tables: nT }, SRC),
        sub("authz_review", "Access-control architecture reviewed (app-layer or RLS)", 6, ev.attest.authzReview === null ? null : 0.6 * ev.attest.authzReview,
          "0.6 x human review score 0-10 (RLS being off is NOT penalised; the real access-control design must be reviewed)",
          { rlsTables: cat.rlsEnabledTables.length, review: ev.attest.authzReview }, "time-bound human attestation"),
      ],
      ["RLS state is informational only; authorization is judged from the application's access-control design."],
    ),
    mk("indexing", [
      sub("fk_indexed", "Declared FKs with a supporting index", 5, declared ? (5 * fkIdx) / declared : 5, "5 x fkIndexed / declaredFks (full marks when there are none)", { declared, fkIndexed: fkIdx }, SRC),
      sub("dup_idx", "No duplicate indexes", 3, 3 * (1 - clamp(dupIdx / Math.max(1, cat.indexes.length), 0, 1)), "3 x (1 - duplicateIndexes / indexes)", { duplicates: dupIdx, indexes: cat.indexes.length }, SRC),
      sub("invalid_idx", "No invalid indexes", 2, invalidIdx === 0 ? 2 : 0, "2 if none are invalid, else 0", { invalid: invalidIdx }, SRC),
    ]),
    mk("migrations", [
      sub("ledger", "Migration ledger table present", 4, cat.migrationLedgers.length ? 4 : 0, "4 if a known ledger table exists", { ledgers: cat.migrationLedgers.join(",") || "none" }, SRC),
      sub("ledger_ver", "Latest applied version readable", 3, cat.migrationLedgers.length ? (cat.migrationLatest ? 3 : 0) : 0, "3 if the newest ledger version can be read", { latest: cat.migrationLatest }, "ledger table"),
      sub("drift", "No unapproved schema change since last scan", 3, ev.schemaChange === "first" ? null : ev.schemaChange === "changed" ? 0 : 3,
        "3 when the schema fingerprint is unchanged or the change was approved; 0 when changed and not approved; N/V on the first scan", { change: ev.schemaChange }, "schema fingerprint"),
    ]),
    mk(
      "backup",
      [
        sub("retention", "Neon history retention", 5, retH === null ? null : 5 * clamp(retH / 168, 0, 1), "5 x min(1, retentionHours / 168h)", { retentionHours: retH === null ? null : r2(retH) }, "Neon API (read-only GET)"),
        sub("branch_prot", "Production branch protected", 3, neon?.protected == null ? null : neon.protected ? 3 : 0, "3 if protected, 0 if not", { branch: neon?.branchName ?? null, protected: neon?.protected ?? null }, "Neon API (read-only GET)"),
        sub("restore", "Restore test evidence", 2, ev.attest.restoreTest === null ? null : 0.2 * ev.attest.restoreTest, "0.2 x human-attested restore test score", { review: ev.attest.restoreTest }, "time-bound human attestation"),
      ],
      ["Secval's existing Backup & Recovery score covers secval's own store and is NOT reused here."],
    ),
    mk("audit", [
      sub("audit_tables", "Audit/history tables exist", 4, auditTables.length ? 4 : 0, "4 if any audit/history/log/version table exists (name-based)", { auditTables: auditTables.length }, `${SRC} (name heuristic)`),
      sub("timestamps", "Tables with created_at", 4, nT ? (4 * tsTables) / nT : null, "4 x tablesWithCreatedAt / tables", { tablesWithCreatedAt: tsTables, tables: nT }, SRC),
      sub("immutable", "Audit tables protected by triggers", 2, auditTables.length ? (2 * auditTables.filter((t) => auditTriggerTables.has(t.name)).length) / auditTables.length : 0, "2 x auditTablesWithTrigger / auditTables", { auditTables: auditTables.length }, SRC),
    ]),
    mk("maintain", [
      sub("wide", "No very wide tables (>60 columns)", 4, nT ? 4 * (1 - wide / nT) : null, "4 x (1 - wideTables / tables)", { wideTables: wide }, SRC),
      sub("naming", "snake_case column names", 3, cat.columns.length ? (3 * snake) / cat.columns.length : null, "3 x snakeCaseColumns / columns", { snake, columns: cat.columns.length }, SRC),
      sub("big_unindexed", "Large tables have secondary indexes", 3, nT ? 3 * (1 - bigUnindexed / nT) : null, "3 x (1 - bigTablesWithOnlyPk / tables); big = >100k estimated rows", { bigUnindexed }, `${SRC} (row estimates)`),
    ]),
  ];
}

export function overallFrom(criteria: CriterionScore[]): { score: number | null; coverage: number; state: VerifyState } {
  const tw = criteria.reduce((a, c) => a + c.weight, 0);
  const coverage = r2(criteria.reduce((a, c) => a + c.weight * c.coverage, 0) / tw);
  const score = coverage < 0.5 ? null : r2(criteria.reduce((a, c) => a + c.weight * (c.score ?? 0), 0) / tw);
  const state: VerifyState = coverage >= 1 ? "VERIFIED" : coverage >= 0.5 ? "PARTIAL" : "UNVERIFIED";
  return { score, coverage, state };
}

/* ---------------- Remediation readiness: the 7 deliverables ---------------- */

export const READINESS_ROWS = [
  { key: "baseline", label: "Verified architecture baseline" },
  { key: "inventory", label: "Complete FK candidate inventory" },
  { key: "orphans", label: "Orphan and integrity analysis" },
  { key: "plan", label: "Priority-ranked correction plan" },
  { key: "drafts", label: "Draft SQL migrations" },
  { key: "scores", label: "Current and target architecture scores" },
  { key: "safeguards", label: "Production-change safeguards" },
] as const;

export function scoreReadiness(ev: Evidence, metricsReconcile: { matched: number; compared: number } | null, archCoverage: number): CriterionScore[] {
  const cat = ev.cat;
  const none = (k: string, l: string) => roll(k, l, 1, [sub("none", "No catalog collected", 10, null, "nothing to score", {}, "none")]);
  if (!cat) return READINESS_ROWS.map((r) => none(r.key, r.label));
  const idCols = cat.columns.filter((c) => /_id$/i.test(c.name)).length;
  const declaredCols = new Set(cat.foreignKeys.flatMap((f) => f.columns.map((c) => `${f.table}.${c}`)));
  const idNoFk = cat.columns.filter((c) => /_id$/i.test(c.name) && !declaredCols.has(`${c.table}.${c.name}`) && !(c.name.toLowerCase() === "id")).length;
  const classified = ev.inventory.filter((c) => c.classification !== "UNVERIFIED").length;
  const decisive = ev.checks.filter((c) => c.outcome !== "ERROR" && c.outcome !== "UNVERIFIED").length;
  const fails = ev.checks.filter((c) => c.outcome === "FAIL");
  const cap = ev.attest.independentlyVerified ? undefined : { max: 8, reason: "Capped at 8: no independent verification recorded (secval's own output cannot prove itself)" };
  const rows = (k: string, subs: SubScore[], open: string[] = []) => roll(k, READINESS_ROWS.find((r) => r.key === k)!.label, 1, subs, open, cap);

  return [
    rows("baseline", [
      sub("collected", "Live catalog collected", 4, 4, "4 when the catalog query succeeded", { tables: cat.tables.length }, SRC),
      sub("reconcile", "Reconciles with the 05 Nov 2026 manual counts", 3, metricsReconcile ? (3 * metricsReconcile.matched) / Math.max(1, metricsReconcile.compared) : null, "3 x matchingMetrics / comparedMetrics (counts may legitimately drift)", { ...(metricsReconcile ?? {}) }, "manual baseline vs live"),
      sub("branch", "Production branch and retention read", 2, ev.neon ? 2 : null, "2 when the Neon API answered", { branch: ev.neon?.branchName ?? null }, "Neon API"),
      sub("persisted", "Snapshot stored", 1, 1, "1 once the scan is persisted", {}, "secval store"),
    ]),
    rows("inventory", [
      sub("generated", "Inventory generated from the catalog", 4, 4, "4 when generated", { candidates: ev.inventory.length }, SRC),
      sub("complete", "Every _id column accounted for", 3, idCols ? Math.min(3, (3 * (ev.inventory.length + (idCols - idNoFk))) / idCols) : 3, "3 x (candidates + _id columns already under a declared FK) / all _id columns", { idColumns: idCols, candidates: ev.inventory.length, underDeclaredFk: idCols - idNoFk }, SRC),
      sub("classified", "Candidates classified from evidence", 3, ev.inventory.length ? (3 * classified) / ev.inventory.length : 3, "3 x classified / candidates", { classified, candidates: ev.inventory.length }, "reviewed registry"),
    ]),
    rows("orphans", [
      sub("defined", "Checks defined for resolvable candidates", 2, ev.checksDefined ? 2 : 0, "2 when at least one check exists", { checksDefined: ev.checksDefined }, "check library"),
      sub("executed", "Checks executed with a decisive result", 4, ev.checksDefined ? (4 * decisive) / ev.checksDefined : 0, "4 x decisive / defined", { decisive, defined: ev.checksDefined }, "read-only aggregate checks"),
      sub("deep", "Deep audit within 48 h", 2, ev.deepAuditAgeHours === null ? null : ev.deepAuditAgeHours <= 48 ? 2 : 0, "2 if the last deep audit is <= 48 h old", { ageHours: ev.deepAuditAgeHours }, "scan history"),
      sub("triage", "Every failure has a recommendation", 2, fails.length ? (2 * ev.recommendationsComplete) / Math.max(1, fails.length) : 2, "2 x recommendations / failed checks", { failed: fails.length, recs: ev.recommendationsComplete }, "recommendation register"),
    ]),
    rows("plan", [
      sub("exists", "Recommendations generated for confirmed weaknesses", 5, ev.recommendationsTotal ? 5 : fails.length || ev.inventory.length ? 0 : 5, "5 when recommendations exist (or there is nothing to fix)", { recs: ev.recommendationsTotal }, "recommendation register"),
      sub("complete", "All 11 required fields filled", 3, ev.recommendationsTotal ? (3 * ev.recommendationsComplete) / ev.recommendationsTotal : null, "3 x completeRecommendations / total", { complete: ev.recommendationsComplete, total: ev.recommendationsTotal }, "recommendation register"),
      sub("ranked", "Ranked P0..P3 with owner", 2, ev.recommendationsTotal ? 2 : null, "2 when a priority and owner are set on every item", {}, "recommendation register"),
    ]),
    rows("drafts", [
      sub("covered", "Draft migration for each recommendation that needs one", 5, ev.needsMigration ? (5 * ev.draftsTotal) / ev.needsMigration : 5, "5 x drafts / recommendationsNeedingMigration", { drafts: ev.draftsTotal, needed: ev.needsMigration }, "draft store"),
      sub("rollback", "Each draft has rollback and test", 3, ev.draftsTotal ? (3 * ev.draftsSafe) / ev.draftsTotal : ev.needsMigration ? 0 : 3, "3 x safeDrafts / drafts", { safe: ev.draftsSafe, drafts: ev.draftsTotal }, "draft store"),
      sub("lint", "Drafts pass the non-destructive lint", 2, ev.draftsTotal ? (2 * ev.draftsSafe) / ev.draftsTotal : ev.needsMigration ? 0 : 2, "2 x lintedDrafts / drafts (no DROP TABLE/TRUNCATE/DELETE; never applied by secval)", { safe: ev.draftsSafe }, "draft lint"),
    ]),
    rows("scores", [
      sub("current", "Current architecture score computed with coverage >= 80%", 5, 5 * clamp(archCoverage / 0.8, 0, 1), "5 x min(1, coverage / 0.8)", { coverage: archCoverage }, "scoring engine"),
      sub("target", "Target defined", 2, 2, "2 (targets are fixed in the spec)", {}, "spec"),
      sub("history", "Previous verified snapshot available", 3, ev.hasPrevious ? 3 : null, "3 once at least one earlier snapshot exists", { hasPrevious: ev.hasPrevious }, "scan history"),
    ]),
    rows("safeguards", [
      sub("ro", "Monitoring session proven read-only", 3, cat.sessionReadOnly === null ? null : cat.sessionReadOnly ? 3 : 0, "3 if transaction_read_only = on", { readOnly: cat.sessionReadOnly }, "pg session setting"),
      sub("branch_known", "Production branch identified", 2, ev.neon?.branchName ? 2 : null, "2 if the default branch was read", { branch: ev.neon?.branchName ?? null }, "Neon API"),
      sub("branch_prot", "Production branch protected", 3, ev.neon?.protected == null ? null : ev.neon.protected ? 3 : 0, "3 if protected", { protected: ev.neon?.protected ?? null }, "Neon API"),
      sub("retention", "History retention >= 24 h", 2, ev.neon?.historyRetentionSeconds == null ? null : ev.neon.historyRetentionSeconds >= 86400 ? 2 : 0, "2 if retention >= 24h", { hours: ev.neon?.historyRetentionSeconds == null ? null : ev.neon.historyRetentionSeconds / 3600 }, "Neon API"),
    ]),
  ];
}

export function readinessOverall(rows: CriterionScore[]): { score: number | null; coverage: number; state: VerifyState } {
  const cov = r2(rows.reduce((a, r) => a + r.coverage, 0) / rows.length);
  const score = cov < 0.5 ? null : r2(rows.reduce((a, r) => a + (r.score ?? 0), 0) / rows.length);
  return { score, coverage: cov, state: cov >= 1 ? "VERIFIED" : cov >= 0.5 ? "PARTIAL" : "UNVERIFIED" };
}
