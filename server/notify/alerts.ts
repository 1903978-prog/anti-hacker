import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";
import type { Finding, Severity } from "../scan/types.js";

/**
 * New-finding alerts. After a sweep, the findings of each scan are compared
 * with the previous completed scan of the same target; anything not seen
 * there is "new". All new findings of one sweep go out in ONE e-mail.
 *
 * Only findings (the fact a weakness exists) are sent — never target data.
 * Alerting can never break a sweep: a missing setting or a failed send is
 * recorded in the audit trail and the sweep carries on.
 */

/** Findings below this level are not worth an e-mail. */
const ALERT_SEVERITIES: Severity[] = ["high", "medium", "low"];
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export interface NewFinding extends Finding {
  host: string;
}

/** One scan's outcome, as the sweep sees it. */
export interface ScanOutcome {
  host: string;
  scanId: string | null;
  findings: Finding[];
}

/**
 * Codes found by the most recent completed scan of `host`, excluding
 * `currentScanId`. Returns null when there is no earlier scan (first scan).
 */
export function previousCodes(db: DB, host: string, currentScanId: string | null): Set<string> | null {
  const prev = db
    .prepare(
      `SELECT id FROM scans
        WHERE target = ? AND status = 'completed' AND id IS NOT ?
        ORDER BY finished_at DESC, started_at DESC LIMIT 1`,
    )
    .get(host, currentScanId) as { id: string } | undefined;
  if (!prev) return null;
  const rows = db.prepare(`SELECT code FROM findings WHERE scan_id = ?`).all(prev.id) as { code: string }[];
  return new Set(rows.map((r) => r.code));
}

/**
 * Alert-worthy findings of this scan that the previous scan of the same host
 * did not have. Call it right after the scan is stored (the scan itself is
 * excluded by id). On a target's first scan every one counts as new.
 */
export function newFindings(db: DB, outcome: ScanOutcome): NewFinding[] {
  const seen = previousCodes(db, outcome.host, outcome.scanId);
  return outcome.findings
    .filter((f) => ALERT_SEVERITIES.includes(f.severity))
    .filter((f) => !seen || !seen.has(f.code))
    .map((f) => ({ ...f, host: outcome.host }));
}

export interface AlertMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

/** Sends one message; throws on failure. Injectable for tests. */
export type Sender = (msg: AlertMessage, apiKey: string) => Promise<void>;

export interface AlertConfig {
  apiKey: string | null;
  to: string;
  from: string;
}

export function alertConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  return {
    apiKey: env.RESEND_API_KEY?.trim() || null,
    to: env.ALERT_TO?.trim() || "livio.moretti@eendigo.com",
    from: env.ALERT_FROM?.trim() || "secval <notifications@operations.eendigo.com>",
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildMessage(items: NewFinding[], cfg: AlertConfig): AlertMessage {
  const sorted = [...items].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.host.localeCompare(b.host),
  );
  const hosts = new Set(sorted.map((i) => i.host));
  const subject = `secval: ${sorted.length} new security finding${sorted.length === 1 ? "" : "s"} on ${hosts.size} site${hosts.size === 1 ? "" : "s"}`;
  const text = [
    "The weekly security scan found weaknesses that were not there last time:",
    "",
    ...sorted.map((i) => `[${i.severity.toUpperCase()}] ${i.host}: ${i.title}\n    ${i.detail}`),
    "",
    "Open the security checker to see every finding.",
  ].join("\n");
  const rows = sorted
    .map(
      (i) =>
        `<tr><td><b>${escapeHtml(i.severity.toUpperCase())}</b></td><td>${escapeHtml(i.host)}</td>` +
        `<td>${escapeHtml(i.title)}<br><span style="color:#666">${escapeHtml(i.detail)}</span></td></tr>`,
    )
    .join("");
  const html =
    `<p>The weekly security scan found weaknesses that were not there last time:</p>` +
    `<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">` +
    `<tr><th align="left">Level</th><th align="left">Site</th><th align="left">Finding</th></tr>${rows}</table>` +
    `<p>Open the security checker to see every finding.</p>`;
  return { to: cfg.to, from: cfg.from, subject, html, text };
}

/** Resend HTTP API, with a timeout so a stalled provider cannot hang a sweep. */
export const resendSender: Sender = async (msg, apiKey) => {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`mail provider answered ${res.status}`);
};

export type AlertOutcome = "none" | "sent" | "not_configured" | "failed";

/** Sends one alert for all new findings of a sweep. Never throws. */
export async function sendAlerts(
  db: DB,
  items: NewFinding[],
  actor: string,
  cfg: AlertConfig = alertConfigFromEnv(),
  send: Sender = resendSender,
): Promise<AlertOutcome> {
  if (items.length === 0) return "none";
  const detail = { newFindings: items.length, sites: [...new Set(items.map((i) => i.host))] };
  if (!cfg.apiKey) {
    appendAudit(db, {
      actor,
      action: "alert.skipped",
      decision: "info",
      reason: "alert e-mail not configured (RESEND_API_KEY missing)",
      detail,
    });
    return "not_configured";
  }
  try {
    await send(buildMessage(items, cfg), cfg.apiKey);
    appendAudit(db, { actor, action: "alert.sent", decision: "info", detail });
    return "sent";
  } catch (err) {
    appendAudit(db, {
      actor,
      action: "alert.failed",
      decision: "info",
      reason: (err as Error).message.slice(0, 200),
      detail,
    });
    return "failed";
  }
}
