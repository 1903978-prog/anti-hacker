import { createHash } from "node:crypto";
import {
  DIMENSIONS,
  type DatasetSpec,
  type DimensionId,
  type DimensionResult,
  type Issue,
  type QualityResult,
  type QualityStatus,
  type Reconciliation,
  type RefreshSubmission,
  type Row,
} from "./types.js";
import { DEFAULT_POLICY, type QualityPolicy } from "./policy.js";

/**
 * The scoring engine. Pure and deterministic: the same submission, spec,
 * baseline and policy always give the same result. No AI judgment, no I/O.
 *
 * Rules that matter (from Livio's brief):
 *  - a check that could not be run is UNVERIFIED and counts 0 in the score; it is never dropped from the denominator,
 *  - only dimensions documented as not applicable in the spec are removed (weights renormalized),
 *  - too little verified weight (policy.minCoverage) gives UNVERIFIED and no score,
 *  - a critical failure caps the score and forces FAIL, whatever the aggregate.
 */

export type Baseline = Map<string, string> | null; // record key -> row fingerprint

const EXTERNAL_KINDS = new Set(["external_fetch", "sync", "import"]);

const isMissing = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export function keyOf(row: Row, keyFields: string[]): string {
  return keyFields.map((f) => String(row[f] ?? "")).join("|");
}

export function fingerprint(row: Row, ignore: string[] = []): string {
  const keys = Object.keys(row)
    .filter((k) => !ignore.includes(k))
    .sort();
  const body = JSON.stringify(keys.map((k) => [k, row[k] ?? null]));
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export function buildBaseline(spec: DatasetSpec, records: Row[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of records) m.set(keyOf(r, spec.keyFields), fingerprint(r, spec.change?.ignoreFields));
  return m;
}

function scored(
  id: DimensionId,
  weight: number,
  checked: number,
  issues: Issue[],
  policy: QualityPolicy,
  failingShare: (i: Issue) => number,
): DimensionResult {
  let penalty = 0;
  for (const i of issues) penalty += 100 * failingShare(i) * policy.severityFactor[i.severity];
  return { id, weight, state: "scored", score: Math.max(0, Math.round((100 - penalty) * 100) / 100), checked, issues };
}

const share = (i: Issue): number => (i.total && i.total > 0 ? Math.min(1, (i.count ?? 0) / i.total) : 1);

const unverified = (id: DimensionId, weight: number, reason: string): DimensionResult => ({
  id,
  weight,
  state: "unverified",
  score: null,
  reason,
  checked: 0,
  issues: [],
});

function sample(keys: string[]): string[] {
  return keys.slice(0, 5);
}

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "date":
      return (typeof v === "string" || v instanceof Date) && !Number.isNaN(new Date(v as string).getTime());
    default:
      return true;
  }
}

export function evaluate(
  spec: DatasetSpec | undefined,
  sub: RefreshSubmission,
  baseline: Baseline,
  policy: QualityPolicy = DEFAULT_POLICY,
  now: Date = new Date(),
): QualityResult {
  const w = policy.weights;
  const rows = sub.records;
  const n = rows.length;
  const allIssues: Issue[] = [];
  const criticalReasons: string[] = [];

  // --- Gate: did the refresh itself happen, and was there evidence? ---------
  if (!sub.operationCompleted) criticalReasons.push("The refresh operation did not complete.");
  const violations = sub.access?.violations ?? [];
  if (sub.access?.initiatorAuthorized === false) criticalReasons.push("Refresh initiated without permission.");
  for (const v of violations.slice(0, 5)) criticalReasons.push(`Security violation: ${v}`);

  let gateUnverified: string | null = null;
  if (!spec) gateUnverified = `No validation rules are configured for dataset "${sub.dataset}".`;
  else if (EXTERNAL_KINDS.has(sub.kind) && sub.sourceReached !== true)
    gateUnverified = `Source "${sub.sourceSystem}" was not reached, so nothing about its data can be verified.`;
  else if (n > policy.maxRecords) gateUnverified = `Dataset has ${n} records, above the ${policy.maxRecords} limit; not scored.`;

  const NA = spec?.notApplicable ?? {};
  const dims: DimensionResult[] = [];

  const add = (d: DimensionResult) => {
    dims.push(d);
    allIssues.push(...d.issues);
  };

  for (const id of DIMENSIONS) {
    const weight = w[id];
    if (!spec || gateUnverified) {
      add(unverified(id, weight, gateUnverified ?? "No rules."));
      continue;
    }
    if (NA[id]) {
      dims.push({ id, weight, state: "not_applicable", score: null, reason: NA[id], checked: 0, issues: [] });
      continue;
    }
    add(runDimension(id, weight, spec, sub, baseline, policy, now));
  }

  // --- Reconciliation (always computed when a spec exists) -------------------
  let reconciliation: Reconciliation | null = null;
  if (spec) reconciliation = reconcile(spec, sub, baseline);

  // --- Critical flags from issues -------------------------------------------
  for (const i of allIssues) {
    if (i.severity === "critical") criticalReasons.push(i.message);
  }
  const critical = criticalReasons.length > 0;

  // --- Aggregate --------------------------------------------------------------
  const applicable = dims.filter((d) => d.state !== "not_applicable");
  const denom = applicable.reduce((s, d) => s + d.weight, 0);
  const verifiedW = applicable.filter((d) => d.state === "scored").reduce((s, d) => s + d.weight, 0);
  const coverage = denom > 0 ? Math.round((verifiedW / denom) * 1000) / 1000 : 0;
  const sum = applicable.reduce((s, d) => s + (d.state === "scored" ? (d.score ?? 0) * d.weight : 0), 0);
  const computable = denom > 0 && coverage >= policy.minCoverage && !gateUnverified;
  const rawScore = computable ? Math.round((sum / denom) * 10) / 10 : null;

  let score = rawScore;
  let status: QualityStatus;
  let outcome: QualityResult["outcome"];
  if (critical) {
    if (score !== null) score = Math.min(score, policy.criticalCap);
    status = "Critical";
    outcome = "FAIL";
  } else if (score === null) {
    status = "UNVERIFIED";
    outcome = "UNVERIFIED";
  } else {
    status = policy.bands.find((b) => score! >= b.min)?.status ?? "Critical";
    outcome = status === "Critical" ? "FAIL" : "PASS";
  }

  return {
    jobId: sub.jobId,
    policyVersion: policy.version,
    specVersion: spec?.version ?? null,
    app: sub.app,
    dataset: sub.dataset,
    outcome,
    status,
    score,
    rawScore,
    coverage,
    critical,
    criticalReasons: [...new Set(criticalReasons)],
    dimensions: dims,
    reconciliation,
    issues: allIssues,
    evaluatedAt: now.toISOString(),
    recordCount: n,
  };
}

function runDimension(
  id: DimensionId,
  weight: number,
  spec: DatasetSpec,
  sub: RefreshSubmission,
  baseline: Baseline,
  policy: QualityPolicy,
  now: Date,
): DimensionResult {
  const rows = sub.records;
  const n = rows.length;
  const issues: Issue[] = [];
  const key = (r: Row) => keyOf(r, spec.keyFields);

  switch (id) {
    case "accuracy": {
      const fields = spec.accuracy?.fields ?? [];
      if (!fields.length) return unverified(id, weight, "No accuracy rule configured.");
      if (!sub.authoritative || Object.keys(sub.authoritative).length === 0)
        return unverified(id, weight, "No authoritative source values were supplied to compare against.");
      const byKey = new Map(rows.map((r) => [key(r), r]));
      const tol = spec.accuracy?.relTolerance ?? 0;
      let checked = 0;
      const bad: string[] = [];
      for (const [k, truth] of Object.entries(sub.authoritative)) {
        const r = byKey.get(k);
        for (const f of fields) {
          if (!(f in truth)) continue;
          checked++;
          const a = r?.[f];
          const b = truth[f];
          const ok =
            typeof a === "number" && typeof b === "number"
              ? Math.abs(a - b) <= Math.abs(b) * tol
              : a !== undefined && String(a) === String(b);
          if (!ok) bad.push(k);
        }
      }
      if (checked === 0) return unverified(id, weight, "Authoritative values did not cover any configured field.");
      if (bad.length)
        issues.push({ dimension: id, severity: "major", code: "accuracy_mismatch", message: `${bad.length} of ${checked} values differ from the authoritative source.`, count: bad.length, total: checked, sample: sample(bad) });
      return scored(id, weight, checked, issues, policy, share);
    }

    case "completeness": {
      const required = spec.fields.filter((f) => f.required);
      if (!required.length && !spec.minRecords) return unverified(id, weight, "No completeness rule configured.");
      if (spec.minRecords && n < spec.minRecords)
        issues.push({ dimension: id, severity: "critical", code: "too_few_records", message: `Expected at least ${spec.minRecords} records, received ${n}.`, count: spec.minRecords - n, total: spec.minRecords });
      for (const f of required) {
        const miss = rows.filter((r) => isMissing(r[f.name]));
        if (miss.length)
          issues.push({ dimension: id, severity: f.requiredSeverity ?? "major", code: `missing_${f.name}`, message: `${miss.length} of ${n} records miss required field "${f.name}".`, count: miss.length, total: n, sample: sample(miss.map(key)) });
      }
      return scored(id, weight, n, issues, policy, share);
    }

    case "referential": {
      const refs = spec.refs ?? [];
      if (!refs.length) return unverified(id, weight, "No referential rule configured.");
      const missingSets = refs.filter((r) => !sub.references?.[r.reference]);
      if (missingSets.length)
        return unverified(id, weight, `Parent key sets not supplied: ${missingSets.map((r) => r.reference).join(", ")}.`);
      for (const ref of refs) {
        const set = new Set((sub.references![ref.reference] ?? []).map(String));
        const broken = rows.filter((r) => {
          const v = r[ref.field];
          if (isMissing(v)) return !ref.nullable;
          return !set.has(String(v));
        });
        if (broken.length)
          issues.push({ dimension: id, severity: "critical", code: `broken_${ref.field}`, message: `${broken.length} of ${n} records have a broken link in "${ref.field}" (to ${ref.reference}).`, count: broken.length, total: n, sample: sample(broken.map(key)) });
      }
      return scored(id, weight, n * refs.length, issues, policy, share);
    }

    case "freshness": {
      const fr = spec.freshness;
      if (!fr) return unverified(id, weight, "No freshness rule configured.");
      // An unchanged local copy proves nothing unless the source confirmed it.
      if (sub.kind !== "external_fetch" && sub.kind !== "sync" && sub.kind !== "import" && sub.sourceReached !== true)
        return unverified(id, weight, "No successful source verification; a local reload or cache does not establish freshness.");
      if (sub.sourceUnchangedConfirmed) return { id, weight, state: "scored", score: 100, checked: n, issues, reason: "Source confirmed unchanged." };
      if (!fr.field) return { id, weight, state: "scored", score: 100, checked: n, issues, reason: "Fetched from the source in this refresh." };
      let newest = -Infinity;
      for (const r of rows) {
        const t = Date.parse(String(r[fr.field] ?? ""));
        if (!Number.isNaN(t) && t > newest) newest = t;
      }
      if (newest === -Infinity) return unverified(id, weight, `No usable timestamps in "${fr.field}".`);
      const ageH = (Date.parse(sub.finishedAt) - newest) / 3_600_000;
      if (ageH <= fr.maxAgeHours) return { id, weight, state: "scored", score: 100, checked: n, issues, reason: `Newest record is ${Math.max(0, Math.round(ageH))} h old (limit ${fr.maxAgeHours} h).` };
      // Linear decay: full marks at the limit, zero at three times the limit.
      const score = Math.max(0, Math.round((100 * (1 - (ageH - fr.maxAgeHours) / (2 * fr.maxAgeHours))) * 100) / 100);
      issues.push({ dimension: id, severity: "major", code: "stale", message: `Newest record is ${Math.round(ageH)} h old; limit is ${fr.maxAgeHours} h.`, count: 1, total: 1 });
      void now;
      return { id, weight, state: "scored", score, checked: n, issues };
    }

    case "consistency": {
      const rules = spec.consistency ?? [];
      if (!rules.length) return unverified(id, weight, "No consistency rule configured.");
      for (const rule of rules) {
        const bad: string[] = [];
        let checked = 0;
        for (const r of rows) {
          const num = (f: string) => (typeof r[f] === "number" ? (r[f] as number) : null);
          let ok = true;
          if (rule.kind === "lte") {
            const a = num(rule.a), b = num(rule.b);
            if (a === null || b === null) continue;
            ok = a <= b;
          } else if (rule.kind === "equals") {
            const a = num(rule.a), b = num(rule.b);
            if (a === null || b === null) continue;
            ok = Math.abs(a - b) <= (rule.tolerance ?? 0);
          } else {
            const parts = rule.parts.map(num), total = num(rule.total);
            if (total === null || parts.some((p) => p === null)) continue;
            ok = Math.abs((parts as number[]).reduce((s, p) => s + p, 0) - total) <= (rule.tolerance ?? 0);
          }
          checked++;
          if (!ok) bad.push(key(r));
        }
        if (bad.length)
          issues.push({ dimension: id, severity: rule.severity ?? "major", code: `rule_${rule.name}`, message: `${bad.length} of ${checked} records break rule "${rule.name}".`, count: bad.length, total: checked, sample: sample(bad) });
      }
      return scored(id, weight, n, issues, policy, share);
    }

    case "uniqueness": {
      if (!spec.keyFields.length) return unverified(id, weight, "No business key configured.");
      const seen = new Map<string, number>();
      let incomplete = 0;
      for (const r of rows) {
        if (spec.keyFields.some((f) => isMissing(r[f]))) { incomplete++; continue; }
        seen.set(key(r), (seen.get(key(r)) ?? 0) + 1);
      }
      const dups = [...seen.entries()].filter(([, c]) => c > 1);
      const dupRows = dups.reduce((s, [, c]) => s + c - 1, 0);
      if (dupRows)
        issues.push({ dimension: id, severity: "critical", code: "duplicate_identity", message: `${dupRows} duplicate business identities across ${dups.length} keys.`, count: dupRows, total: n, sample: sample(dups.map(([k]) => k)) });
      if (incomplete)
        issues.push({ dimension: id, severity: "major", code: "key_incomplete", message: `${incomplete} records have an incomplete business key.`, count: incomplete, total: n });
      return scored(id, weight, n, issues, policy, share);
    }

    case "validity": {
      const checks = spec.fields.filter((f) => f.type || f.min !== undefined || f.max !== undefined || f.pattern || f.oneOf);
      if (!checks.length) return unverified(id, weight, "No validity rule configured.");
      for (const f of checks) {
        const bad: string[] = [];
        let checked = 0;
        const re = f.pattern ? new RegExp(f.pattern) : null;
        for (const r of rows) {
          const v = r[f.name];
          if (isMissing(v)) continue; // missing is a completeness matter
          checked++;
          let ok = f.type ? typeOk(f.type, v) : true;
          if (ok && typeof v === "number") {
            if (f.min !== undefined && v < f.min) ok = false;
            if (f.max !== undefined && v > f.max) ok = false;
          }
          if (ok && re && !re.test(String(v))) ok = false;
          if (ok && f.oneOf && !f.oneOf.includes(v as string | number)) ok = false;
          if (!ok) bad.push(key(r));
        }
        if (bad.length)
          issues.push({ dimension: id, severity: "major", code: `invalid_${f.name}`, message: `${bad.length} of ${checked} values of "${f.name}" are invalid.`, count: bad.length, total: checked, sample: sample(bad) });
      }
      return scored(id, weight, n, issues, policy, share);
    }

    case "provenance": {
      const fields = spec.provenance?.fields ?? [];
      if (!fields.length) return unverified(id, weight, "No provenance rule configured.");
      for (const f of fields) {
        const miss = rows.filter((r) => isMissing(r[f]));
        if (miss.length)
          issues.push({ dimension: id, severity: "major", code: `no_${f}`, message: `${miss.length} of ${n} records have no "${f}" (source trace).`, count: miss.length, total: n, sample: sample(miss.map(key)) });
      }
      return scored(id, weight, n, issues, policy, share);
    }

    case "change": {
      const ch = spec.change;
      if (!ch) return unverified(id, weight, "No change-integrity rule configured.");
      if (!baseline) return unverified(id, weight, "No verified earlier snapshot yet; this run becomes the baseline.");
      const rec = reconcile(spec, sub, baseline);
      const before = rec.before;
      if (before > 0) {
        // Penalty grows from 0 at the threshold to full at twice the threshold.
        const over = (pct: number, max: number) => (max <= 0 ? (pct > 0 ? 1 : 0) : Math.min(1, Math.max(0, (pct - max) / max)));
        const removedPct = (rec.unexplainedRemoved / before) * 100;
        const changedPct = (rec.updated / before) * 100;
        const jumpPct = (Math.abs(rec.unexplainedAdded - rec.unexplainedRemoved) / before) * 100;
        const r1 = over(removedPct, ch.maxRemovedPct);
        const r2 = over(changedPct, ch.maxChangedPct);
        const r3 = over(jumpPct, ch.maxCountJumpPct);
        if (r1 > 0) issues.push({ dimension: id, severity: "major", code: "unexplained_removals", message: `${rec.unexplainedRemoved} of ${before} records disappeared without explanation (${removedPct.toFixed(1)}%, limit ${ch.maxRemovedPct}%).`, count: Math.round(r1 * 1000), total: 1000 });
        if (r2 > 0) issues.push({ dimension: id, severity: "major", code: "mass_overwrite", message: `${rec.updated} of ${before} records changed (${changedPct.toFixed(1)}%, limit ${ch.maxChangedPct}%).`, count: Math.round(r2 * 1000), total: 1000 });
        if (r3 > 0) issues.push({ dimension: id, severity: "major", code: "count_jump", message: `Record count moved by ${jumpPct.toFixed(1)}% without explanation (limit ${ch.maxCountJumpPct}%).`, count: Math.round(r3 * 1000), total: 1000 });
      }
      return scored(id, weight, before, issues, policy, share);
    }

    case "access": {
      if (!sub.access || sub.access.initiatorAuthorized === undefined || sub.access.initiatorAuthorized === null)
        return unverified(id, weight, "The app did not report a permission check for this refresh.");
      const v = sub.access.violations ?? [];
      if (!sub.access.initiatorAuthorized)
        issues.push({ dimension: id, severity: "critical", code: "unauthorized_refresh", message: "Refresh initiated without permission.", count: 1, total: 1 });
      if (v.length)
        issues.push({ dimension: id, severity: "critical", code: "access_violation", message: `${v.length} access violation(s) reported.`, count: 1, total: 1 });
      return scored(id, weight, 1, issues, policy, share);
    }
  }
}

export function reconcile(spec: DatasetSpec, sub: RefreshSubmission, baseline: Baseline): Reconciliation {
  const after = buildBaseline(spec, sub.records);
  if (!baseline) {
    return { baseline: true, before: 0, after: after.size, added: after.size, removed: 0, updated: 0, unchanged: 0, unexplainedRemoved: 0, unexplainedAdded: 0 };
  }
  let added = 0, updated = 0, unchanged = 0;
  for (const [k, h] of after) {
    const prev = baseline.get(k);
    if (prev === undefined) added++;
    else if (prev !== h) updated++;
    else unchanged++;
  }
  let removed = 0;
  for (const k of baseline.keys()) if (!after.has(k)) removed++;
  const exp = sub.expectedChange ?? {};
  return {
    baseline: false,
    before: baseline.size,
    after: after.size,
    added,
    removed,
    updated,
    unchanged,
    unexplainedRemoved: Math.max(0, removed - (exp.removed ?? 0)),
    unexplainedAdded: Math.max(0, added - (exp.added ?? 0)),
  };
}

