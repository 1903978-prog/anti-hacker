import type { AppKey, Catalog, CheckResult, FkCandidate, NeonSettings, RecommendationDraft, Severity } from "./types.js";
import { ident } from "./readonly.js";

const FIELDS: Array<keyof RecommendationDraft> = ["issue", "target", "evidence", "rootCause", "correction", "expectedImprovement", "riskEffort", "migrationOrCode", "verificationTest", "rollback", "owner", "priority"];

/** All 11+ required fields present and non-empty. */
export function isComplete(r: RecommendationDraft): boolean {
  return FIELDS.every((f) => String(r[f] ?? "").trim().length > 0);
}

/**
 * Draft SQL is a PROPOSAL stored as text. Secval has no code path that
 * executes it. The lint keeps drafts non-destructive: the forward section may
 * only ADD constraints/indexes; DROP is allowed only in the rollback section.
 */
export function lintDraftSql(sql: string): { ok: boolean; reason?: string } {
  const [forward = "", rollback] = sql.split(/^-- ROLLBACK.*$/m);
  if (rollback === undefined) return { ok: false, reason: "no ROLLBACK section" };
  if (!/^-- VERIFY/m.test(sql)) return { ok: false, reason: "no VERIFY section" };
  const code = forward.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  if (/\b(drop|truncate|delete|update|insert|alter\s+table\s+\S+\s+alter\s+column|rename|grant|revoke)\b/i.test(code)) {
    return { ok: false, reason: "forward section contains a destructive statement" };
  }
  return { ok: true };
}

export function fkDraft(c: FkCandidate): string | null {
  if (!c.targetTable || !c.targetColumn || (c.classification !== "mandatory" && c.classification !== "optional")) return null;
  const name = `fk_${c.sourceTable}_${c.sourceColumn}`.slice(0, 60);
  const child = ident(c.sourceTable), col = ident(c.sourceColumn), parent = ident(c.targetTable), pcol = ident(c.targetColumn);
  return [
    `-- DRAFT PROPOSAL. Not applied by secval. Needs written approval and a maintenance window.`,
    `-- Precondition: the orphan check for ${c.sourceTable}.${c.sourceColumn} returns 0 failures.`,
    `ALTER TABLE ${child} ADD CONSTRAINT ${ident(name)} FOREIGN KEY (${col}) REFERENCES ${parent} (${pcol}) NOT VALID;`,
    `ALTER TABLE ${child} VALIDATE CONSTRAINT ${ident(name)};`,
    `-- VERIFY: re-run the secval orphan check (0 failures) and confirm the constraint is validated in pg_constraint.`,
    `-- ROLLBACK`,
    `ALTER TABLE ${child} DROP CONSTRAINT ${ident(name)};`,
  ].join("\n");
}

export function indexDraft(table: string, columns: string[]): string {
  const name = `ix_${table}_${columns.join("_")}`.slice(0, 60);
  return [
    `-- DRAFT PROPOSAL. Not applied by secval.`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ident(name)} ON ${ident(table)} (${columns.map(ident).join(", ")});`,
    `-- VERIFY: the index exists, is valid (pg_index.indisvalid) and the join/lookups use it (EXPLAIN).`,
    `-- ROLLBACK`,
    `DROP INDEX CONCURRENTLY IF EXISTS ${ident(name)};`,
  ].join("\n");
}

interface Input {
  app: AppKey;
  cat: Catalog | null;
  inventory: FkCandidate[];
  checks: CheckResult[];
  neon: NeonSettings | null;
}

export function buildRecommendations(i: Input): RecommendationDraft[] {
  const out: RecommendationDraft[] = [];
  const owner = "Application owner (Livio to assign)";
  const add = (r: Omit<RecommendationDraft, "app" | "owner"> & { owner?: string }) => out.push({ app: i.app, owner, ...r });

  for (const c of i.checks.filter((x) => x.outcome === "FAIL")) {
    add({
      id: `fail:${c.checkId}`,
      priority: c.severity,
      issue: `Orphan rows: ${c.invariant}`,
      target: c.tables.join(" -> "),
      evidence: c.evidence,
      rootCause: "UNKNOWN (needs application-code and history inspection)",
      correction: c.recommendation,
      expectedImprovement: "Orphans removed or repaired; the foreign key can then be enforced.",
      riskEffort: "Medium risk (data repair), 0.5-2 days.",
      migrationOrCode: "Data-repair script (reviewed, run in a transaction on a branch copy first), then the FK draft migration.",
      verificationTest: `Re-run check ${c.checkId} v${c.version}: expect 0 failures.`,
      rollback: "Run on a Neon branch first; restore from the branch if the repair is wrong.",
      draftSql: null,
    });
  }
  for (const c of i.inventory.filter((x) => x.classification === "mandatory" || x.classification === "optional")) {
    const sql = fkDraft(c);
    add({
      id: `fk:${c.sourceTable}.${c.sourceColumn}`,
      priority: c.criticality === "high" ? "P1" : "P2",
      issue: `Missing foreign key (${c.classification})`,
      target: `${c.sourceTable}.${c.sourceColumn} -> ${c.targetTable}.${c.targetColumn}`,
      evidence: c.evidence,
      rootCause: "UNKNOWN",
      correction: c.recommendedAction,
      expectedImprovement: "Database enforces the relationship; Foreign-key integrity criterion rises.",
      riskEffort: "Low risk with NOT VALID then VALIDATE; 1-2 hours plus approval.",
      migrationOrCode: "Draft SQL migration (below), applied only after written approval.",
      verificationTest: "Orphan check returns 0; constraint appears validated in pg_constraint.",
      rollback: "ALTER TABLE ... DROP CONSTRAINT (in the draft).",
      draftSql: sql,
    });
  }
  const unclassified = i.inventory.filter((x) => x.classification === "UNVERIFIED");
  if (unclassified.length) {
    add({
      id: "classify:candidates",
      priority: "P2",
      issue: `${unclassified.length} candidate relational column(s) not yet classified`,
      target: unclassified.slice(0, 5).map((c) => `${c.sourceTable}.${c.sourceColumn}`).join(", ") + (unclassified.length > 5 ? ", ..." : ""),
      evidence: "Columns end in _id without a declared foreign key. A name alone is not proof of a relationship.",
      rootCause: "UNKNOWN until application code is inspected",
      correction: "Inspect the code for each column and record mandatory / optional / external / intentionally non-FK in the reviewed registry.",
      expectedImprovement: "Inventory completeness and FK-integrity confidence rise; false findings are avoided.",
      riskEffort: "No production risk; effort scales with candidates.",
      migrationOrCode: "Code change to server/dbarch/registry.ts only (no database change).",
      verificationTest: "Re-scan: classified count equals the registry entries.",
      rollback: "Revert the registry commit.",
      draftSql: null,
    });
  }
  for (const t of i.cat?.tables.filter((t) => !t.hasPrimaryKey) ?? []) {
    add({
      id: `pk:${t.name}`, priority: "P1", issue: "Table without a primary key", target: t.name,
      evidence: "pg_constraint has no primary key for this table.", rootCause: "UNKNOWN",
      correction: "Choose a natural or surrogate key, confirm uniqueness on existing rows, then add the primary key.",
      expectedImprovement: "Primary-key coverage reaches 100%.", riskEffort: "Medium: uniqueness must be proven first; 0.5 day.",
      migrationOrCode: "Migration after a duplicate check (no draft generated: the key choice is a business decision).",
      verificationTest: "pg_constraint shows a primary key; duplicate check returns 0.", rollback: "ALTER TABLE ... DROP CONSTRAINT <pk>.", draftSql: null,
    });
  }
  if (i.cat) {
    const seen = new Set<string>();
    for (const f of i.cat.foreignKeys) {
      const supported = i.cat.indexes.some((x) => x.table === f.table && f.columns.every((c, n) => x.columns[n] === c));
      if (supported || seen.has(`${f.table}.${f.columns}`)) continue;
      seen.add(`${f.table}.${f.columns}`);
      add({
        id: `idx:${f.table}.${f.columns.join("+")}`, priority: "P2", issue: "Foreign key without a supporting index", target: `${f.table}(${f.columns.join(", ")})`,
        evidence: `${f.name} has no index starting with its columns, so joins and parent deletes can scan the table.`, rootCause: "UNKNOWN",
        correction: "Create the index CONCURRENTLY.", expectedImprovement: "Faster joins; Indexing criterion rises.", riskEffort: "Low risk, short lock-free build; 1 hour.",
        migrationOrCode: "Draft SQL migration.", verificationTest: "Index valid; EXPLAIN uses it.", rollback: "DROP INDEX CONCURRENTLY (in the draft).",
        draftSql: indexDraft(f.table, f.columns),
      });
    }
  }
  if (i.neon?.protected === false) {
    add({
      id: "neon:branch-protection", priority: "P1", issue: "Production branch is not protected", target: `Neon branch ${i.neon.branchName ?? "?"}`,
      evidence: "Neon API reports protected = false.", rootCause: "Setting never enabled (UNKNOWN whether deliberate)",
      correction: "Enable branch protection in the Neon console (secval never changes it).", expectedImprovement: "Safeguards and Backup criteria rise; protects against accidental deletion.",
      riskEffort: "Low risk, 5 minutes; may be a paid-plan feature (confirm price first).", migrationOrCode: "Neon setting change by the owner.",
      verificationTest: "Next secval Quick Refresh shows protected = true.", rollback: "Disable protection in the console.", draftSql: null,
    });
  }
  if (i.neon?.historyRetentionSeconds != null && i.neon.historyRetentionSeconds < 86400) {
    add({
      id: "neon:retention", priority: "P1", issue: "Recovery window below 24 hours", target: "Neon history retention",
      evidence: `History retention is ${(i.neon.historyRetentionSeconds / 3600).toFixed(1)} h.`, rootCause: "Plan default (UNKNOWN whether chosen)",
      correction: "Raise history retention to at least 7 days if the plan allows (price to be confirmed first).", expectedImprovement: "Backup and Safeguards criteria rise.",
      riskEffort: "No data risk; may increase storage cost.", migrationOrCode: "Neon project setting by the owner.",
      verificationTest: "Next Quick Refresh shows the new retention.", rollback: "Set retention back.", draftSql: null,
    });
  }
  const order: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return out.sort((a, b) => order[a.priority] - order[b.priority] || a.id.localeCompare(b.id));
}
