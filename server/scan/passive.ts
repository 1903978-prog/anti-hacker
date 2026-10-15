import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import { requestApproval } from "../governance/policy.js";
import { isEngaged } from "../governance/killswitch.js";
import { appendAudit } from "../audit/log.js";
import { analyzeCookies, analyzeHeaders, analyzeTls } from "./checks.js";
import { httpProbe as realHttp, tlsProbe as realTls } from "./probes.js";
import type { Finding, HttpProbe, TlsProbe } from "./types.js";

export interface ScanResult {
  scanId: string | null;
  status: "completed" | "denied" | "aborted";
  reason?: string;
  host?: string;
  findings: Finding[];
}

export interface ScanDeps {
  httpProbe?: HttpProbe;
  tlsProbe?: TlsProbe;
}

/**
 * Runs a passive scan of an allowlisted, ownership-proven target. The policy
 * engine is asked for approval FIRST; if it denies, nothing runs. Only passive
 * reads are performed (one GET + one TLS handshake), and only findings — never
 * target data — are retained.
 */
export async function runPassiveScan(
  db: DB,
  req: { actor: string; target: string },
  deps: ScanDeps = {},
): Promise<ScanResult> {
  const decision = requestApproval(db, { actor: req.actor, target: req.target, mode: "passive" });
  if (!decision.allowed || !decision.host) {
    return { scanId: null, status: "denied", reason: decision.reason, findings: [] };
  }

  const host = decision.host;
  const limits = decision.effectiveLimits!;
  const scanId = randomUUID();
  const startedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO scans (id, target, mode, status, started_at) VALUES (?, ?, 'passive', 'running', ?)`,
  ).run(scanId, host, startedAt);
  appendAudit(db, {
    actor: req.actor,
    action: "scan.start",
    target: host,
    mode: "passive",
    decision: "info",
    detail: { scanId },
  });

  const httpProbe = deps.httpProbe ?? realHttp;
  const tlsProbe = deps.tlsProbe ?? realTls;

  // Defense in depth: honor the kill switch even after approval.
  if (isEngaged(db)) {
    return abort(db, scanId, req.actor, host, "kill switch engaged mid-scan");
  }

  let findings: Finding[] = [];
  try {
    // Two passive reads, within the approved runtime budget.
    const [http, tlsResult] = await withTimeout(
      Promise.all([httpProbe(`https://${host}/`, limits.maxRuntimeMs), tlsProbe(host, limits.maxRuntimeMs)]),
      limits.maxRuntimeMs,
    );

    findings = [
      ...analyzeHeaders(http),
      ...analyzeCookies(http.setCookies),
      ...analyzeTls(tlsResult),
    ];
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
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const f of kept) insert.run(scanId, f.severity, f.code, f.title, f.detail, now);
    db.prepare(`UPDATE scans SET status = 'completed', finished_at = ?, findings_count = ? WHERE id = ?`).run(
      now,
      kept.length,
      scanId,
    );
  });
  tx();

  appendAudit(db, {
    actor: req.actor,
    action: "scan.complete",
    target: host,
    mode: "passive",
    decision: "info",
    detail: { scanId, findings: kept.length },
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
    mode: "passive",
    decision: "deny",
    reason,
    detail: { scanId },
  });
  return { scanId, status: "aborted", reason, host, findings: [] };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("scan runtime exceeded")), ms + 500)),
  ]);
}

/** Reads stored findings for a scan. */
export function getFindings(db: DB, scanId: string): Finding[] {
  const rows = db
    .prepare(`SELECT severity, code, title, detail FROM findings WHERE scan_id = ? ORDER BY id`)
    .all(scanId) as Array<Record<string, string>>;
  return rows.map((r) => ({
    severity: r.severity as Finding["severity"],
    code: r.code!,
    title: r.title!,
    detail: r.detail!,
  }));
}

export interface ScanSummary {
  id: string;
  target: string;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  findingsCount: number;
}

export function listScans(db: DB, limit = 50): ScanSummary[] {
  const rows = db
    .prepare(`SELECT * FROM scans ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    target: r.target as string,
    mode: r.mode as string,
    status: r.status as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
    findingsCount: Number(r.findings_count ?? 0),
  }));
}
