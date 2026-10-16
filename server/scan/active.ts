import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import { requestApproval } from "../governance/policy.js";
import { isEngaged } from "../governance/killswitch.js";
import { appendAudit } from "../audit/log.js";
import { SENSITIVE_PATHS, analyzeExposure } from "./checks.js";
import { httpProbe as realHttp } from "./probes.js";
import type { Finding, HttpProbe } from "./types.js";
import type { ScanResult } from "./passive.js";

export interface ActiveScanDeps {
  httpProbe?: HttpProbe;
  /** Delay between requests (rate limiting); injectable so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock in ms; injectable for deterministic runtime-budget tests. */
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the gentlest active scan: non-destructive, read-only probing for a few
 * commonly-leaked paths and misconfigurations on an allowlisted, ownership-
 * proven, ACTIVE-ELIGIBLE target.
 *
 * Governance first: the policy engine is asked for approval with mode="active"
 * BEFORE anything runs. Active mode is denied unless the domain is explicitly
 * marked active-eligible (which itself requires proven ownership), so this
 * cannot run against a target that only cleared passive scanning.
 *
 * Safety properties upheld here:
 *  - every request is a GET (zero data-mutating operations);
 *  - requests are throttled to the approved max requests/second and capped at
 *    the approved max total requests and runtime budget;
 *  - the kill switch is honored before each request, not just at the start;
 *  - exposure is judged from HTTP status only — response bodies are never read
 *    or retained, so findings record that a weakness exists, never the data;
 *  - a catch-all server (2xx for unknown paths) short-circuits the path checks
 *    to avoid false positives.
 */
export async function runActiveScan(
  db: DB,
  req: { actor: string; target: string },
  deps: ActiveScanDeps = {},
): Promise<ScanResult> {
  const decision = requestApproval(db, { actor: req.actor, target: req.target, mode: "active" });
  if (!decision.allowed || !decision.host) {
    return { scanId: null, status: "denied", reason: decision.reason, findings: [] };
  }

  const host = decision.host;
  const limits = decision.effectiveLimits!;
  const scanId = randomUUID();
  const startedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO scans (id, target, mode, status, started_at) VALUES (?, ?, 'active', 'running', ?)`,
  ).run(scanId, host, startedAt);
  appendAudit(db, {
    actor: req.actor,
    action: "scan.start",
    target: host,
    mode: "active",
    decision: "info",
    detail: { scanId },
  });

  const httpProbe = deps.httpProbe ?? realHttp;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  // Defense in depth: honor the kill switch even after approval.
  if (isEngaged(db)) {
    return abort(db, scanId, req.actor, host, "kill switch engaged mid-scan");
  }

  const findings: Finding[] = [];
  const startedMs = now();
  const minGapMs = Math.ceil(1000 / limits.maxRequestsPerSecond);
  let sent = 0;

  const withinBudget = () => now() - startedMs < limits.maxRuntimeMs;
  const canSend = () => sent < limits.maxTotalRequests && withinBudget();

  try {
    // Baseline: a server that returns 2xx for a random unknown path is a
    // catch-all; status-based path checks would be meaningless, so skip them.
    if (!canSend()) {
      return abort(db, scanId, req.actor, host, "request/runtime budget exhausted before any probe");
    }
    const noisePath = `/secval-probe-${randomUUID().slice(0, 8)}`;
    const baseline = await httpProbe(`https://${host}${noisePath}`, limits.maxRuntimeMs);
    sent++;

    if (baseline.status >= 200 && baseline.status < 300) {
      findings.push({
        severity: "info",
        code: "exposed-check-inconclusive",
        title: "Path checks inconclusive",
        detail:
          "The server returns success for unknown paths (catch-all), so missing-file checks were skipped to avoid false positives.",
      });
    } else {
      for (const p of SENSITIVE_PATHS) {
        if (isEngaged(db)) {
          return abort(db, scanId, req.actor, host, "kill switch engaged mid-scan");
        }
        if (!canSend()) break;
        await sleep(minGapMs); // rate limit
        if (!canSend()) break; // budget may have run out while waiting
        const res = await httpProbe(`https://${host}${p.path}`, limits.maxRuntimeMs);
        sent++;
        const f = analyzeExposure(p, res.status);
        if (f) findings.push(f);
      }
    }
  } catch (err) {
    return abort(db, scanId, req.actor, host, `scan error: ${(err as Error).message}`);
  }

  // Retain only findings; cap the number kept to respect the retention limit.
  const maxFindings = Math.max(1, Math.floor(limits.maxRetainedBytes / 512));
  const kept = findings.slice(0, maxFindings);

  const insert = db.prepare(
    `INSERT INTO findings (scan_id, severity, code, title, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const finishedAt = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const f of kept) insert.run(scanId, f.severity, f.code, f.title, f.detail, finishedAt);
    db.prepare(
      `UPDATE scans SET status = 'completed', finished_at = ?, findings_count = ? WHERE id = ?`,
    ).run(finishedAt, kept.length, scanId);
  });
  tx();

  appendAudit(db, {
    actor: req.actor,
    action: "scan.complete",
    target: host,
    mode: "active",
    decision: "info",
    detail: { scanId, findings: kept.length, requests: sent },
  });

  return { scanId, status: "completed", host, findings: kept };
}

function abort(db: DB, scanId: string, actor: string, host: string, reason: string): ScanResult {
  db.prepare(`UPDATE scans SET status = 'aborted', finished_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    scanId,
  );
  appendAudit(db, {
    actor,
    action: "scan.abort",
    target: host,
    mode: "active",
    decision: "deny",
    reason,
    detail: { scanId },
  });
  return { scanId, status: "aborted", reason, host, findings: [] };
}
