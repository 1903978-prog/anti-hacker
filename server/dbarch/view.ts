import type { DB } from "../db.js";
import { APPS, HISTORICAL_BASELINE, STALE_AFTER_MS, TARGETS } from "./apps.js";
import type { AppResult } from "./engine.js";
import { ARCH_WEIGHTS, READINESS_ROWS } from "./scoring.js";
import { activeAttestations, getLatest, listAlerts, recentScans, type ScanRow } from "./store.js";
import type { AppKey, CriterionScore, VerifyState } from "./types.js";

interface Compact {
  findingIds?: string[];
  architecture: { score: number | null; criteria: Array<{ key: string; score: number | null; state: string }> };
  readiness: { score: number | null; rows: Array<{ key: string; score: number | null; state: string }> };
}

function parse(r: ScanRow): Compact | null {
  try { return JSON.parse(r.summary_json) as Compact; } catch { return null; }
}

function scoreAt(scans: ScanRow[], daysAgo: number, now: Date): number | null {
  const cutoff = now.getTime() - daysAgo * 86_400_000;
  const hit = scans.find((s) => s.status !== "error" && Date.parse(s.finished_at) <= cutoff && s.arch_score !== null);
  return hit?.arch_score ?? null;
}

export function buildView(db: DB, env: NodeJS.ProcessEnv, now: Date) {
  const apps = (Object.keys(APPS) as AppKey[]).map((app) => {
    const cfg = APPS[app];
    const configured = Boolean(env[cfg.envVar]);
    const latest = getLatest(db, app);
    const scans = recentScans(db, app, 60);
    const lastRow = scans[0] ?? null;
    const good = scans.filter((s) => s.status !== "error");
    const res = latest?.result as unknown as AppResult | undefined;
    const attest = activeAttestations(db, app, now);
    const overrides = [...attest.values()].filter((a) => a.key.startsWith("override:"));

    const globalState = (s: VerifyState): VerifyState => {
      if (!res) return "UNVERIFIED";
      if (lastRow?.status === "error") return "ERROR";
      if (now.getTime() - Date.parse(latest!.updated_at) > STALE_AFTER_MS) return "STALE";
      return s;
    };

    const prevComp = good.slice(1).map(parse);
    const cell = (c: CriterionScore, group: "architecture" | "readiness", prefix: "a" | "r", target: number) => {
      const ov = attest.get(`override:${prefix}_${c.key}`);
      const prior = prevComp.map((p) => p?.[group === "architecture" ? "architecture" : "readiness"]).map((g) => {
        const arr = group === "architecture" ? (g as Compact["architecture"] | undefined)?.criteria : (g as Compact["readiness"] | undefined)?.rows;
        return arr?.find((x) => x.key === c.key)?.score ?? null;
      }).find((v) => v !== null) ?? null;
      // Last time this cell had real evidence.
      let lastVerifiedAt: string | null = null;
      for (let i = 0; i < good.length; i++) {
        const comp = i === 0 ? null : prevComp[i - 1];
        const arr = group === "architecture" ? comp?.architecture.criteria : comp?.readiness.rows;
        const v = i === 0 ? c : arr?.find((x) => x.key === c.key);
        const st = (v as { state?: string } | undefined)?.state;
        if (st === "VERIFIED" || st === "PARTIAL") { lastVerifiedAt = good[i]!.finished_at; break; }
      }
      return {
        key: c.key, label: c.label, weight: c.weight, measured: c.score, coverage: c.coverage, target,
        effective: ov && ov.value !== null ? ov.value : c.score,
        override: ov ? { value: ov.value, reason: ov.reason, approvedBy: ov.approved_by, since: ov.created_at, expiresAt: ov.expires_at } : null,
        state: globalState(c.state as VerifyState), rawState: c.state,
        previous: prior, delta: c.score !== null && prior !== null ? Math.round((c.score - prior) * 100) / 100 : null,
        lastVerifiedAt, subscores: c.subscores, open: c.open, capReason: c.capReason ?? null,
      };
    };

    const arch = res ? res.architecture.criteria.map((c) => cell(c, "architecture", "a", TARGETS.architecture)) : [];
    const ready = res ? res.readiness.rows.map((c) => cell(c, "readiness", "r", TARGETS.readiness)) : [];
    const effOverall = (cells: typeof arch, weighted: boolean) => {
      const tw = cells.reduce((a, c) => a + (weighted ? c.weight : 1), 0);
      return Math.round((cells.reduce((a, c) => a + (weighted ? c.weight : 1) * (c.effective ?? 0), 0) / tw) * 100) / 100;
    };
    const prevArch = good[1]?.arch_score ?? null;
    const prevReady = good[1]?.ready_score ?? null;
    const archScore = res && res.architecture.score !== null ? effOverall(arch, true) : null;
    const readyScore = res && res.readiness.score !== null ? effOverall(ready, false) : null;
    return {
      app, label: cfg.label, projectId: cfg.neonProjectId, configured,
      neon: res?.neon ?? null,
      lastScanAt: latest?.updated_at ?? null, lastDeepAt: latest?.deep_at ?? null,
      lastError: lastRow?.status === "error" ? lastRow.error_label : null,
      headline: {
        architecture: { score: archScore, measured: res?.architecture.score ?? null, coverage: res?.architecture.coverage ?? 0, state: globalState((res?.architecture.state as VerifyState) ?? "UNVERIFIED"), target: TARGETS.architecture, previous: prevArch, delta: archScore !== null && prevArch !== null ? Math.round((archScore - prevArch) * 100) / 100 : null, trend7: scoreAt(scans, 7, now), trend30: scoreAt(scans, 30, now) },
        readiness: { score: readyScore, measured: res?.readiness.score ?? null, coverage: res?.readiness.coverage ?? 0, state: globalState((res?.readiness.state as VerifyState) ?? "UNVERIFIED"), target: TARGETS.readiness, previous: prevReady, delta: readyScore !== null && prevReady !== null ? Math.round((readyScore - prevReady) * 100) / 100 : null },
      },
      historical: { architecture: HISTORICAL_BASELINE.architecture[app], asOf: HISTORICAL_BASELINE.asOf, kind: "HISTORICAL MANUAL BASELINE", source: HISTORICAL_BASELINE.source },
      architectureCriteria: arch, readinessRows: ready,
      catalog: res?.catalog ?? null, reconcile: res?.reconcile ?? [], schemaChange: res?.schemaChange ?? null,
      overrides,
      history: good.slice(0, 30).map((s) => ({ at: s.finished_at, tier: s.tier, architecture: s.arch_score, readiness: s.ready_score, status: s.status })).reverse(),
      findingCounts: (res?.recommendations ?? []).reduce((a, r) => ({ ...a, [r.priority]: (a[r.priority] ?? 0) + 1 }), {} as Record<string, number>),
      newFindings: newFindingIds(res, prevComp[0]?.findingIds ?? null),
      resolvedFindings: resolvedIds(res, prevComp[0]?.findingIds ?? null),
    };
  });
  return {
    generatedAt: now.toISOString(), calcVersion: "dbarch-1.0.0",
    note: "Scores are measured by secval from read-only catalog queries. Missing evidence shows N/V and lowers coverage; it is never shown as zero or green.",
    targets: TARGETS, weights: ARCH_WEIGHTS, readinessRows: READINESS_ROWS,
    cadence: { quick: "every 6 hours and on Refresh", deep: "every 24 hours and on demand" },
    apps, alerts: listAlerts(db, undefined, 50),
  };
}

function newFindingIds(res: AppResult | undefined, prev: string[] | null): string[] { return prev && res ? res.recommendations.map((r) => r.id).filter((i) => !prev.includes(i)) : []; }
function resolvedIds(res: AppResult | undefined, prev: string[] | null): string[] { return prev && res ? prev.filter((i) => !res.recommendations.some((r) => r.id === i)) : []; }
