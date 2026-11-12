/**
 * EEES v1.0 scoring engine. Pure functions: criteria + one app's evidence
 * (+ cross-app flows + Secval's own live measurements) -> scorecard.
 *
 * Rules implemented exactly as written in eees/v1.0/STANDARD.md:
 *  - Each check earns credit = ceiling(evidence level) / 10 when verified,
 *    0 when failed or UNKNOWN. So synthetic-only evidence can never pass 6,
 *    production-like 8, production without independent sustained proof 9.
 *  - UNKNOWN stays UNKNOWN: a dimension with no known check scores 0 in the
 *    assured score. A coding agent's claim, a "verified" without a link and
 *    evidence older than the check's cadence all count as UNKNOWN.
 *  - N/A needs a justification AND a reviewer; its weight is redistributed
 *    inside the same domain. Without both it is UNKNOWN.
 *  - Hard gates cap the assured score; a high average never overrides one.
 *  - Release status comes from gates only, never from a PR being ready.
 */
import type {
  AppEntry,
  CheckDef,
  CheckResult,
  Criteria,
  Defect,
  EvidenceFile,
  EvidenceItem,
  Flow,
  FlowsFile,
  Level,
} from "./types.js";

const DAY = 86_400_000;
const LEVEL_RANK: Record<Level, number> = { synthetic: 0, prodlike: 1, production: 2, "independent-sustained": 3 };

export type CheckSource = "evidence file" | "flow inventory" | "secval live";

export interface ScoredCheck {
  id: string;
  title: string;
  acceptance: string;
  method: string;
  cadence: string;
  references: string[];
  status: "verified" | "failed" | "unknown" | "na";
  level: Level | null;
  credit: number;
  /** Why the engine changed or kept the status (stale, agent claim, no link...). */
  reason: string | null;
  evidence: EvidenceItem[];
  evidenceDate: string | null;
  note: string | null;
  source: CheckSource;
  effort: string | null;
  risk: string | null;
}

export interface ScoredDimension {
  id: string;
  n: number;
  name: string;
  domain: string;
  weight: number;
  effectiveWeight: number;
  definitionOf10: string;
  state: "scored" | "unknown" | "na";
  naJustification: string | null;
  raw: number;
  adjusted: number;
  counts: { required: number; applicable: number; verified: number; failed: number; unknown: number; na: number };
  evidenceDate: string | null;
  environments: string[];
  reviewers: string[];
  checks: ScoredCheck[];
  defects: Defect[];
}

export interface GateResult {
  id: string;
  text: string;
  cap: number;
  blocksRelease: boolean;
  trigger: "presence" | "absence";
  status: "pass" | "fail" | "unknown";
  /** True when this gate's cap is applied to the assured score. */
  applied: boolean;
  reason: string;
}

export interface Improvement {
  rank: number;
  dimension: string;
  dimensionName: string;
  check: string | null;
  title: string;
  why: string;
  realOrUnverified: "real defect" | "unverified" | "weak evidence" | "expired evidence";
  defects: string[];
  businessImpact: string;
  effort: string;
  risk: string;
  expectedGain: number;
  owner: string;
  testsToClose: string;
  gateRelated: boolean;
}

export interface AppScore {
  id: string;
  name: string;
  kind: AppEntry["kind"];
  parent: string | null;
  tier: AppEntry["tier"];
  owner: string;
  repo: string | null;
  hasEvidence: boolean;
  assessedAt: string | null;
  assessor: string | null;
  productionVersion: EvidenceFile["productionVersion"];
  lastIndependentVerification: string | null;
  /** Conservative assured score /10 after hard-gate caps. */
  assured: number;
  /** Weighted evidence-adjusted score before caps. */
  weighted: number;
  /** Weighted raw score (share of verified checks, no ceilings, no caps). Not an assurance figure. */
  raw: number;
  cap: number | null;
  coverage: number;
  productionConfidence: { pct: number; label: "none" | "low" | "medium" | "high" };
  domains: Array<{ id: string; name: string; weight: number; assured: number | null; raw: number | null }>;
  dimensions: ScoredDimension[];
  gates: GateResult[];
  releaseGates: Array<{ id: string; text: string; status: "pass" | "fail" | "unknown"; note: string | null }>;
  releaseStatus: "BLOCKED" | "NOT READY" | "READY FOR RELEASE REVIEW";
  releaseReasons: string[];
  /** Minimum production-readiness thresholds (STANDARD.md Part B rule 17). */
  readiness: { meets: boolean; label: string; unmet: string[] };
  criticalFindings: string[];
  defects: Defect[];
  defectRegister: EvidenceFile["defectRegister"] | null;
  improvements: Improvement[];
  top3: Improvement[];
  trend: { previous: number; date: string; delta: number } | null;
  notes: string[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function newest(items: EvidenceItem[]): string | null {
  let best: string | null = null;
  for (const e of items) if (!best || e.date > best) best = e.date;
  return best;
}

function ceilingOf(criteria: Criteria, level: Level): number {
  return criteria.evidenceLevels.find((l) => l.id === level)?.ceiling ?? 0;
}

/** Applies the evidence rules to one check result. */
export function scoreCheck(
  criteria: Criteria,
  def: CheckDef,
  result: CheckResult | undefined,
  source: CheckSource,
  now: Date,
): ScoredCheck {
  const base: ScoredCheck = {
    id: def.id,
    title: def.title,
    acceptance: def.acceptance,
    method: def.method,
    cadence: def.cadence,
    references: def.references,
    status: "unknown",
    level: null,
    credit: 0,
    reason: null,
    evidence: result?.evidence ?? [],
    evidenceDate: newest(result?.evidence ?? []),
    note: result?.note ?? null,
    source,
    effort: result?.effort ?? null,
    risk: result?.risk ?? null,
  };
  if (!result) return { ...base, reason: "no evidence recorded" };

  if (result.status === "na") {
    if (result.justification && result.reviewer) return { ...base, status: "na", reason: `N/A: ${result.justification} (approved by ${result.reviewer})` };
    return { ...base, reason: "N/A without justification and reviewer approval counts as UNKNOWN" };
  }
  if (result.status === "unknown") return { ...base, reason: result.note ?? "not verified yet" };

  const real = result.evidence.filter((e) => e.kind !== "agent-claim");
  if (real.length === 0) {
    return {
      ...base,
      reason:
        result.evidence.length > 0
          ? "only a coding agent's claim; not independent evidence"
          : `"${result.status}" recorded without an evidence link`,
    };
  }
  const date = newest(real)!;
  const maxAge = criteria.cadences[def.cadence] ?? 35;
  const ageDays = (now.getTime() - Date.parse(date)) / DAY;
  if (ageDays > maxAge) {
    return { ...base, evidenceDate: date, reason: `evidence from ${date} is older than the ${def.cadence} cadence (${maxAge} days): reassess` };
  }

  if (result.status === "failed") return { ...base, status: "failed", evidenceDate: date, reason: null };

  let level: Level = result.level ?? "synthetic";
  let reason: string | null = result.level ? null : "no evidence level given: treated as synthetic";
  if (level === "independent-sustained" && !result.reviewer && !real.some((e) => e.reviewer)) {
    level = "production";
    reason = "independent-sustained claimed without a named reviewer: treated as production";
  }
  return {
    ...base,
    status: "verified",
    level,
    credit: ceilingOf(criteria, level) / 10,
    evidenceDate: date,
    reason,
  };
}

/** Flow-derived results for D04.2 (consumed flows inside SLO) and D05.4 (flow documentation). */
export function flowResults(flows: FlowsFile | null, appId: string): Record<string, CheckResult> {
  if (!flows) return {};
  const parties = (s: string): string[] => s.split(",").map((x) => x.trim());
  const consumed = flows.flows.filter((f) => parties(f.consumer).includes(appId));
  const involved = flows.flows.filter((f) => parties(f.consumer).includes(appId) || parties(f.producer).includes(appId));
  const out: Record<string, CheckResult> = {};
  const ev = (f: Flow): EvidenceItem => ({ link: `eees/flows.json#${f.id}: ${f.evidence}`, kind: "measurement", date: f.measuredAt, environment: "production" });

  if (consumed.length) {
    const failing = consumed.filter((f) => f.status === "failing");
    const unknown = consumed.filter((f) => f.status === "unknown");
    if (failing.length) {
      out["D04.2"] = { status: "failed", evidence: failing.map(ev), note: `failing: ${failing.map((f) => `${f.id} ${f.name}`).join("; ")}` };
    } else if (unknown.length) {
      out["D04.2"] = { status: "unknown", evidence: [], note: `not measured: ${unknown.map((f) => `${f.id} ${f.name}`).join("; ")}` };
    } else {
      out["D04.2"] = { status: "verified", level: "production", evidence: consumed.map(ev), note: `${consumed.length} consumed flow(s) healthy` };
    }
  }
  if (involved.length) {
    const gaps: string[] = [];
    for (const f of involved) {
      const missing = flows.requiredFields.filter((k) => (f as Record<string, unknown>)[k] == null);
      if (missing.length) gaps.push(`${f.id}: ${missing.length} of ${flows.requiredFields.length} fields missing (${missing.join(", ")})`);
    }
    const docEv: EvidenceItem = { link: "eees/flows.json", kind: "review", date: flows.updated, environment: "repository" };
    out["D05.4"] = gaps.length
      ? { status: "failed", evidence: [docEv], note: gaps.join("; ") }
      : { status: "verified", level: "prodlike", evidence: [docEv], note: `${involved.length} flow(s) fully documented` };
  }
  return out;
}

function pick(cands: Array<{ result: CheckResult; source: CheckSource }>): { result: CheckResult; source: CheckSource } | undefined {
  // The most recent evidence wins; an empty or unknown candidate never hides a dated one.
  let best: { result: CheckResult; source: CheckSource; date: string } | undefined;
  for (const c of cands) {
    const date = newest(c.result.evidence) ?? "";
    if (!best || (date > best.date && (c.result.status !== "unknown" || best.result.status === "unknown"))) best = { ...c, date };
    else if (best.result.status === "unknown" && c.result.status !== "unknown") best = { ...c, date };
  }
  return best;
}

function gateFromFile(ev: EvidenceFile | null, id: string): "pass" | "fail" | "unknown" {
  return ev?.gates[id]?.status ?? "unknown";
}

function isOpen(d: Defect): boolean {
  return d.status !== "closed-verified";
}

const DOMAIN_IMPACT: Record<string, string> = {
  DATA: "Wrong or stale data reaches decisions and other apps",
  SEC: "Exposure of client or personal data, or unauthorized action",
  BIZ: "Wrong business result, figure or workflow outcome",
  OPS: "Outage, data loss or failure noticed too late",
  ENG: "Slower, riskier changes and releases",
};

/** Scores one app. `evidence` null means nothing has been assessed: everything is UNKNOWN. */
export function scoreApp(
  criteria: Criteria,
  app: AppEntry,
  evidence: EvidenceFile | null,
  flows: FlowsFile | null,
  live: Record<string, CheckResult> = {},
  now: Date = new Date(),
): AppScore {
  const fromFlows = flowResults(flows, app.id);
  const defects = evidence?.defects ?? [];
  const dims: ScoredDimension[] = [];

  for (const d of criteria.dimensions) {
    const dimNA = evidence?.dimensionsNA[d.id];
    const checks: ScoredCheck[] = d.checks.map((def) => {
      const cands: Array<{ result: CheckResult; source: CheckSource }> = [];
      const f = evidence?.checks[def.id];
      if (f) cands.push({ result: f, source: "evidence file" });
      if (fromFlows[def.id]) cands.push({ result: fromFlows[def.id]!, source: "flow inventory" });
      if (live[def.id]) cands.push({ result: live[def.id]!, source: "secval live" });
      const chosen = pick(cands);
      return scoreCheck(criteria, def, chosen?.result, chosen?.source ?? "evidence file", now);
    });
    const counts = { required: checks.length, applicable: 0, verified: 0, failed: 0, unknown: 0, na: 0 };
    let credit = 0;
    for (const c of checks) {
      if (c.status === "na") counts.na++;
      else {
        counts.applicable++;
        if (c.status === "verified") counts.verified++;
        if (c.status === "failed") counts.failed++;
        if (c.status === "unknown") counts.unknown++;
        credit += c.credit;
      }
    }
    const isNA = !!dimNA || counts.applicable === 0;
    const state: ScoredDimension["state"] = isNA ? "na" : counts.unknown === counts.applicable ? "unknown" : "scored";
    const all = checks.flatMap((c) => c.evidence);
    dims.push({
      id: d.id,
      n: d.n,
      name: d.name,
      domain: d.domain,
      weight: d.weight,
      effectiveWeight: 0,
      definitionOf10: d.definitionOf10,
      state,
      naJustification: dimNA ? `${dimNA.justification} (approved by ${dimNA.reviewer})` : isNA ? "every check N/A with approval" : null,
      raw: isNA ? 0 : round2((10 * counts.verified) / counts.applicable),
      adjusted: isNA ? 0 : round2((10 * credit) / counts.applicable),
      counts,
      evidenceDate: newest(all),
      environments: [...new Set(all.map((e) => e.environment))],
      reviewers: [...new Set(all.map((e) => e.reviewer).filter((r): r is string => !!r))],
      checks,
      defects: defects.filter((x) => x.dimensions.includes(d.id)),
    });
  }

  // Redistribute N/A weight inside each domain.
  const domains = criteria.domains.map((dom) => {
    const inDom = dims.filter((x) => x.domain === dom.id);
    const live = inDom.filter((x) => x.state !== "na");
    const liveW = live.reduce((s, x) => s + x.weight, 0);
    for (const x of live) x.effectiveWeight = liveW ? round2((x.weight * dom.weight) / liveW) : 0;
    const assured = liveW ? round2(live.reduce((s, x) => s + x.weight * x.adjusted, 0) / liveW) : null;
    const raw = liveW ? round2(live.reduce((s, x) => s + x.weight * x.raw, 0) / liveW) : null;
    return { id: dom.id, name: dom.name, weight: liveW ? dom.weight : 0, assured, raw };
  });
  const scoredDims = dims.filter((x) => x.state !== "na");
  const totalW = scoredDims.reduce((s, x) => s + x.effectiveWeight, 0) || 1;
  const weighted = round2(scoredDims.reduce((s, x) => s + x.effectiveWeight * x.adjusted, 0) / totalW);
  const raw = round2(scoredDims.reduce((s, x) => s + x.effectiveWeight * x.raw, 0) / totalW);
  const coverage = round1(
    (100 * scoredDims.reduce((s, x) => s + x.effectiveWeight * ((x.counts.verified + x.counts.failed) / x.counts.applicable), 0)) / totalW,
  );
  const prodShare =
    (100 *
      scoredDims.reduce((s, x) => {
        const strong = x.checks.filter((c) => c.status === "verified" && c.level && LEVEL_RANK[c.level] >= LEVEL_RANK.production).length;
        return s + x.effectiveWeight * (strong / x.counts.applicable);
      }, 0)) /
    totalW;
  const pc = round1(prodShare);
  const productionConfidence = { pct: pc, label: (pc >= 80 ? "high" : pc >= 50 ? "medium" : pc > 0 ? "low" : "none") as AppScore["productionConfidence"]["label"] };

  // --- Hard gates -----------------------------------------------------------
  const openDefects = defects.filter(isOpen);
  const failedCritical = dims.flatMap((d) =>
    d.checks.filter((c) => c.status === "failed" && c.evidence.some((e) => e.environment === "production")).map((c) => ({ dim: d, c })),
  );
  const critKind = (checkId: string): string | undefined =>
    criteria.dimensions.flatMap((d) => d.checks).find((c) => c.id === checkId)?.critical;

  const gates: GateResult[] = criteria.hardGates.map((g) => {
    const file = gateFromFile(evidence, g.id);
    let status: GateResult["status"] = file;
    const reasons: string[] = [];
    if (evidence?.gates[g.id]?.note) reasons.push(evidence.gates[g.id]!.note!);
    if (g.id === "G1") {
      const hits = openDefects.filter((d) => d.severity === "P0" && d.category === "security" && d.exploitable);
      if (hits.length) {
        status = "fail";
        reasons.push(`exploitable security defect(s) open: ${hits.map((d) => d.id).join(", ")}`);
      }
    }
    if (g.id === "G2") {
      const hits = openDefects.filter((d) => d.severity === "P0" && ["data", "financial", "recovery"].includes(d.category));
      const checks = failedCritical.filter((x) => ["financial", "recovery"].includes(critKind(x.c.id) ?? ""));
      if (hits.length || checks.length) {
        status = "fail";
        if (hits.length) reasons.push(`P0 data/financial/recovery defect(s) present in production: ${hits.map((d) => d.id).join(", ")}`);
        if (checks.length) reasons.push(`failed on production: ${checks.map((x) => x.c.id).join(", ")}`);
      }
    }
    if (g.id === "G3") {
      const hits = openDefects.filter((d) => d.severity === "P1" && d.material !== false);
      if (hits.length) {
        status = "fail";
        reasons.push(`${hits.length} material P1 defect(s) unresolved in production`);
      }
    }
    const applied = g.trigger === "absence" ? status !== "pass" : status === "fail";
    if (!reasons.length) {
      reasons.push(
        status === "pass"
          ? "passed with recorded evidence"
          : status === "unknown"
            ? g.trigger === "absence"
              ? "no evidence that this exists: cap applies"
              : "not assessed: cannot be declared release ready"
            : "failed",
      );
    }
    return { id: g.id, text: g.text, cap: g.cap, blocksRelease: g.blocksRelease, trigger: g.trigger, status, applied, reason: reasons.join("; ") };
  });
  const caps = gates.filter((g) => g.applied).map((g) => g.cap);
  const cap = caps.length ? Math.min(...caps) : null;
  const assured = round1(cap === null ? weighted : Math.min(weighted, cap));

  // --- Release status ---------------------------------------------------------
  const releaseGates = criteria.releaseGates.map((r) => {
    const s = evidence?.releaseGates[r.id];
    return { id: r.id, text: r.text, status: s?.status ?? "unknown", note: s?.note ?? null };
  });
  const releaseReasons: string[] = [];
  for (const g of gates) if (g.blocksRelease && g.status === "fail") releaseReasons.push(`${g.id} failed: ${g.reason}`);
  for (const r of releaseGates) if (r.status === "fail") releaseReasons.push(`${r.id} gate failed${r.note ? `: ${r.note}` : ""}`);
  let releaseStatus: AppScore["releaseStatus"] = releaseReasons.length ? "BLOCKED" : "READY FOR RELEASE REVIEW";
  if (releaseStatus !== "BLOCKED") {
    const unknown = [
      ...gates.filter((g) => g.trigger !== "absence" && g.status !== "pass").map((g) => g.id),
      ...releaseGates.filter((r) => r.status !== "pass").map((r) => `${r.id} gate`),
    ];
    if (unknown.length) {
      releaseStatus = "NOT READY";
      releaseReasons.push(`not assessed: ${unknown.join(", ")}`);
    }
  }

  // --- Production-readiness thresholds (Part B rule 17) --------------------------
  // Critical workflows weigh more through per-dimension floors, never by relaxing a gate.
  const FLOORS: Record<string, string[]> = {
    critical: ["D02", "D07", "D08", "D09", "D10", "D12", "D16", "D23"],
    standard: ["D07", "D08", "D09", "D10", "D23"],
    public: ["D09", "D10"],
  };
  const unmet: string[] = [];
  if (assured < 8) unmet.push(`assured ${assured} below 8.0`);
  if (releaseStatus !== "READY FOR RELEASE REVIEW") unmet.push(`release status ${releaseStatus}`);
  for (const id of FLOORS[app.tier] ?? []) {
    const d = dims.find((x) => x.id === id)!;
    if (d.state !== "na" && d.adjusted < 8) unmet.push(`${id} ${d.name} ${d.state === "unknown" ? "UNKNOWN" : d.adjusted} below floor 8`);
  }
  if (openDefects.some((x) => x.severity === "P0" || (x.severity === "P1" && x.material !== false))) unmet.push("open P0/P1 defects");
  const readiness = {
    meets: unmet.length === 0,
    label: unmet.length ? "BELOW PRODUCTION-READINESS THRESHOLD" : assured >= 9 ? "PRODUCTION READY (verified)" : "PRODUCTION READY (minimum)",
    unmet,
  };

  // --- Critical findings ------------------------------------------------------
  const criticalFindings = [
    ...openDefects.filter((d) => d.severity === "P0").map((d) => `${d.id} (P0 ${d.category}, ${d.status}): ${d.title}`),
    ...failedCritical.filter((x) => critKind(x.c.id)).map((x) => `${x.c.id} failed on production: ${x.c.title}${x.c.note ? ` (${x.c.note})` : ""}`),
  ];

  // --- Improvement engine -------------------------------------------------------
  const improvements: Improvement[] = [];
  for (const d of scoredDims) {
    if (d.adjusted >= 9.5) continue;
    const share = d.effectiveWeight / totalW;
    for (const c of d.checks) {
      if (c.status === "na" || c.credit >= 0.9) continue;
      const kind: Improvement["realOrUnverified"] =
        c.status === "failed"
          ? "real defect"
          : c.status === "verified"
            ? "weak evidence"
            : c.reason?.includes("older than")
              ? "expired evidence"
              : "unverified";
      const related = d.defects.filter(isOpen);
      const gateRelated = !!critKind(c.id) || related.some((x) => x.severity === "P0");
      improvements.push({
        rank: 0,
        dimension: d.id,
        dimensionName: d.name,
        check: c.id,
        title: c.title,
        why:
          kind === "real defect"
            ? `Failed${c.note ? `: ${c.note}` : ""}`
            : kind === "weak evidence"
              ? `Verified only at "${c.level}" level (ceiling ${c.credit * 10})`
              : kind === "expired evidence"
                ? c.reason ?? "evidence expired"
                : `No reliable evidence yet${c.reason && c.reason !== "no evidence recorded" ? ` (${c.reason})` : ""}`,
        realOrUnverified: kind,
        defects: related.map((x) => x.id),
        businessImpact: related.find((x) => x.impact)?.impact ?? DOMAIN_IMPACT[d.domain] ?? "not assessed",
        effort: c.effort ?? related.find((x) => x.effort)?.effort ?? "not estimated",
        risk: c.risk ?? related.find((x) => x.risk)?.risk ?? "not assessed",
        expectedGain: round2((share * 10 * (0.9 - c.credit)) / d.counts.applicable),
        owner: app.owner,
        testsToClose: c.acceptance,
        gateRelated,
      });
    }
  }
  const DOMAIN_RISK: Record<string, number> = { SEC: 0, DATA: 1, OPS: 2, BIZ: 3, ENG: 4 };
  // Business risk first: confirmed failures on gate-related checks, then other failures,
  // then unverified gate-related checks, then expired evidence, then the rest.
  const tierOf = (i: Improvement): number => {
    const real = i.realOrUnverified === "real defect";
    if (real && i.gateRelated) return 0;
    if (real) return 1;
    if (i.gateRelated) return 2;
    return i.realOrUnverified === "expired evidence" ? 3 : 4;
  };
  const riskOf = (i: Improvement): number => DOMAIN_RISK[dims.find((x) => x.id === i.dimension)?.domain ?? ""] ?? 9;
  // Inside a tier: checks that feed the release-blocking gates (security, financial, recovery) come first.
  const gateOf = (i: Improvement): number => {
    const k = i.check ? critKind(i.check) : undefined;
    return k && k !== "governance" ? 0 : k ? 1 : 2;
  };
  improvements.sort(
    (a, b) => tierOf(a) - tierOf(b) || gateOf(a) - gateOf(b) || riskOf(a) - riskOf(b) || b.expectedGain - a.expectedGain,
  );
  improvements.forEach((i, n) => (i.rank = n + 1));

  // --- Trend --------------------------------------------------------------------
  const today = now.toISOString().slice(0, 10);
  const prev = [...(evidence?.history ?? [])].filter((h) => h.date.slice(0, 10) < today).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const trend = prev ? { previous: prev.assured, date: prev.date, delta: round1(assured - prev.assured) } : null;

  return {
    id: app.id,
    name: app.name,
    kind: app.kind,
    parent: app.parent ?? null,
    tier: app.tier,
    owner: app.owner,
    repo: app.repo,
    hasEvidence: dims.some((d) => d.counts.verified + d.counts.failed > 0) || defects.length > 0,
    assessedAt: evidence?.assessedAt ?? null,
    assessor: evidence?.assessor ?? null,
    productionVersion: evidence?.productionVersion ?? null,
    lastIndependentVerification: evidence?.lastIndependentVerification ?? null,
    assured,
    weighted,
    raw,
    cap,
    coverage,
    productionConfidence,
    domains,
    dimensions: dims,
    gates,
    releaseGates,
    releaseStatus,
    releaseReasons,
    readiness,
    criticalFindings,
    defects,
    defectRegister: evidence?.defectRegister ?? null,
    improvements,
    top3: improvements.slice(0, 3),
    trend,
    notes: evidence?.notes ?? [],
  };
}

export interface Portfolio {
  /** ESII: tier-weighted mean of assured scores over applications and infrastructure (subsystems excluded). */
  esii: number;
  formula: string;
  counted: Array<{ id: string; tier: string; weight: number; assured: number }>;
  coverage: number;
  appsAssessed: number;
  appsTotal: number;
  blocked: string[];
  unassessed: string[];
}

/** ESII portfolio index. Apps without evidence count as 0, so the index can only rise with real evidence. */
export function portfolioIndex(criteria: Criteria, scores: AppScore[]): Portfolio {
  const weightOf = (tier: string): number => criteria.tiers.find((t) => t.id === tier)?.esiiWeight ?? 1;
  const counted = scores
    .filter((s) => s.kind !== "subsystem")
    .map((s) => ({ id: s.id, tier: s.tier, weight: weightOf(s.tier), assured: s.assured, coverage: s.coverage }));
  const W = counted.reduce((s, x) => s + x.weight, 0) || 1;
  return {
    esii: round1(counted.reduce((s, x) => s + x.weight * x.assured, 0) / W),
    formula:
      "ESII = sum(tier weight x assured score) / sum(tier weights), over applications and infrastructure; subsystems are excluded to avoid double counting; tier weights critical 3, standard 2, public 1; an app with no evidence counts as 0.",
    counted: counted.map(({ coverage: _c, ...x }) => x),
    coverage: round1(counted.reduce((s, x) => s + x.weight * x.coverage, 0) / W),
    appsAssessed: scores.filter((s) => s.hasEvidence).length,
    appsTotal: scores.length,
    blocked: scores.filter((s) => s.releaseStatus === "BLOCKED").map((s) => s.id),
    unassessed: scores.filter((s) => !s.hasEvidence).map((s) => s.id),
  };
}
