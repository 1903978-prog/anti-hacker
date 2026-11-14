import { createHash } from "node:crypto";
import type { AppKey, Catalog, CheckDef, CheckResult, FkCandidate, Severity } from "./types.js";
import { ident, isolated, type RoQueryable } from "./readonly.js";
import { family } from "./inventory.js";

/** Safe budgets: aggregated counts only, bounded number and size of checks. */
export const BUDGET = {
  quick: { maxChecks: 12, maxChildRows: 500_000 },
  deep: { maxChecks: 250, maxChildRows: 20_000_000 },
} as const;

/**
 * Builds the approved orphan-check library for one app from the live catalog.
 * A check exists only for a candidate with ONE unambiguous target and
 * compatible types. Severity is high only when the relationship is classified
 * mandatory in the registry; unclassified candidates yield P3 "candidate" checks
 * whose failures are reported but never treated as a verified defect.
 */
export function buildChecks(app: AppKey, cat: Catalog, inv: FkCandidate[]): Array<CheckDef & { classification: FkCandidate["classification"]; criticality: FkCandidate["criticality"] }> {
  const typeOf = new Map(cat.columns.map((c) => [`${c.table}.${c.name}`, c.type]));
  const out: Array<CheckDef & { classification: FkCandidate["classification"]; criticality: FkCandidate["criticality"] }> = [];
  for (const c of inv) {
    if (!c.targetTable || !c.targetColumn || c.targetAmbiguous) continue;
    if (c.classification === "external" || c.classification === "intentional-non-fk") continue; // deliberate: never a finding
    const ct = typeOf.get(`${c.sourceTable}.${c.sourceColumn}`) ?? "";
    const pt = typeOf.get(`${c.targetTable}.${c.targetColumn}`) ?? "";
    if (family(ct) !== family(pt)) continue;
    const verified = c.classification === "mandatory" || c.classification === "optional";
    const severity: Severity = verified ? (c.criticality === "high" ? "P0" : "P1") : "P3";
    out.push({
      id: `orph:${c.sourceTable}.${c.sourceColumn}`,
      version: 1,
      app,
      tables: [c.sourceTable, c.targetTable],
      invariant: `Every non-null ${c.sourceTable}.${c.sourceColumn} exists in ${c.targetTable}.${c.targetColumn}`,
      severity,
      tier: c.criticality === "high" ? "quick" : "deep",
      child: { table: c.sourceTable, column: c.sourceColumn },
      parent: { table: c.targetTable, column: c.targetColumn },
      recommendation: verified
        ? `Repair or remove orphan rows in ${c.sourceTable}.${c.sourceColumn}, then add a foreign key (see draft migration).`
        : `Classify ${c.sourceTable}.${c.sourceColumn} first; orphans here are not yet a confirmed defect.`,
      classification: c.classification,
      criticality: c.criticality,
    });
  }
  return out;
}

const queryId = (d: CheckDef) => `${d.id}@v${d.version}#${createHash("sha256").update(`${d.child.table}.${d.child.column}>${d.parent.table}.${d.parent.column}`).digest("hex").slice(0, 8)}`;

export function orphanSql(d: CheckDef): string {
  const c = `c.${ident(d.child.column)}`;
  return (
    `SELECT count(*) FILTER (WHERE ${c} IS NOT NULL) AS examined, ` +
    `count(*) FILTER (WHERE ${c} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ident(d.parent.table)} p WHERE p.${ident(d.parent.column)} = ${c})) AS failures ` +
    `FROM ${ident(d.child.table)} c`
  );
}

export interface RunOptions {
  tier: "quick" | "deep";
  /** Epoch ms after which no new check starts (total time budget). */
  deadline?: number;
  now?: () => number;
}

/** Runs the checks of the chosen tier within budget; each result is an aggregate (counts only). */
export async function runChecks(
  rawClient: RoQueryable,
  cat: Catalog,
  defs: ReturnType<typeof buildChecks>,
  opts: RunOptions,
): Promise<CheckResult[]> {
  const budget = BUDGET[opts.tier];
  const rows = new Map(cat.tables.map((t) => [t.name, t.estRows]));
  const eligible = defs.filter((d) => opts.tier === "deep" || d.tier === "quick");
  const results: CheckResult[] = [];
  let ran = 0;
  for (const d of eligible) {
    const base = { checkId: d.id, version: d.version, app: d.app, tables: d.tables, invariant: d.invariant, severity: d.severity, queryId: queryId(d), recommendation: d.recommendation };
    const est = rows.get(d.child.table) ?? -1;
    if (ran >= budget.maxChecks) {
      results.push({ ...base, outcome: "UNVERIFIED", rowsExamined: null, failures: null, evidence: "Skipped: check budget for this scan reached." });
      continue;
    }
    if (est > budget.maxChildRows) {
      results.push({ ...base, outcome: "UNVERIFIED", rowsExamined: null, failures: null, evidence: `Skipped: ${d.child.table} is estimated at ${est} rows, above the ${opts.tier} scan budget.` });
      continue;
    }
    if (opts.deadline !== undefined && (opts.now ?? Date.now)() > opts.deadline) {
      results.push({ ...base, outcome: "UNVERIFIED", rowsExamined: null, failures: null, evidence: "Skipped: time budget for this scan reached." });
      continue;
    }
    ran++;
    try {
      const r = await isolated(rawClient, orphanSql(d));
      const examined = Number(r.rows[0]?.examined ?? 0);
      const failures = Number(r.rows[0]?.failures ?? 0);
      const confirmed = d.classification === "mandatory" || d.classification === "optional";
      results.push({
        ...base,
        outcome: failures === 0 ? "PASS" : confirmed ? "FAIL" : "UNVERIFIED",
        rowsExamined: examined,
        failures,
        evidence:
          failures === 0
            ? `${examined} rows examined, no orphans.`
            : confirmed
              ? `${failures} of ${examined} rows have no parent.`
              : `${failures} of ${examined} rows have no matching ${d.parent.table} row, but the relationship is not classified yet, so this is not a confirmed defect.`,
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "42501") {
        results.push({ ...base, outcome: "UNVERIFIED", rowsExamined: null, failures: null, evidence: "No SELECT grant on the key columns yet (least privilege). Apply the generated column grants to enable this check." });
        continue;
      }
      results.push({ ...base, outcome: "ERROR", rowsExamined: null, failures: null, evidence: "The check could not run (timeout or permission). Details are not shown." });
    }
  }
  return results;
}
