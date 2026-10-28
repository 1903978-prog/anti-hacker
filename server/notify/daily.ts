import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";
import { alertConfigFromEnv, resendSender, type AlertConfig, type Sender } from "./alerts.js";
import { dashboardHosts } from "../health/report.js";
import { listUptime } from "../health/uptime.js";
import { CI_REPOS, getCiSignal, type CiSignal } from "../health/ci.js";
import { allUsage } from "../usage/providers.js";

/**
 * One daily production-health e-mail (Livio 28/10): per app up/down, newest
 * GitHub run, failures that need him, Actions minutes. Anything secval cannot
 * measure says "not measured". Sent once a day from 07:00 UTC to ALERT_TO.
 */
const SENT_KEY = "digest_last_sent";
const SEND_FROM_UTC_HOUR = 7;

export interface DigestInput {
  now: Date;
  ci: (host: string) => CiSignal | null;
  usageLines: string[];
  cfg: AlertConfig;
}

export interface Digest {
  subject: string;
  text: string;
  needsAttention: number;
}

export function buildDigest(db: DB, input: DigestInput): Digest {
  const since = new Date(input.now.getTime() - 2 * 24 * 3_600_000).toISOString();
  const lines: string[] = [];
  const attention: string[] = [];
  for (const { host } of dashboardHosts(db)) {
    const checks = listUptime(db, host, since);
    const last = checks[checks.length - 1];
    const up = !last ? "not measured" : last.ok ? `UP (status ${last.status}, ${last.ms} ms, ${last.ts.slice(0, 16).replace("T", " ")} UTC)` : `DOWN (${last.status ?? last.error ?? "no answer"})`;
    if (last && !last.ok) attention.push(`${host} is DOWN`);
    const ci = input.ci(host);
    let build = CI_REPOS[host] ? "not measured (GitHub gave no answer; private repo?)" : "not measured (no repo linked)";
    if (ci) {
      build = ci.latest
        ? `newest run ${ci.latest.name}: ${ci.latest.conclusion} (${ci.latest.at.slice(0, 16).replace("T", " ")} UTC)`
        : "no finished runs";
      for (const f of ci.failing) attention.push(`${host}: ${f.name} is failing, ${f.url}`);
    }
    lines.push(`${host}\n  Live: ${up}\n  Build/deploy on main: ${build}\n  Nightly live check: not measured (none exists yet)`);
  }
  const subject = attention.length
    ? `secval daily: ${attention.length} thing${attention.length === 1 ? " needs" : "s need"} you`
    : "secval daily: nothing needs you";
  const text = [
    attention.length ? "Needs you:\n" + attention.map((a) => `- ${a}`).join("\n") : "Nothing needs you today.",
    "",
    ...lines,
    "",
    "GitHub Actions:",
    ...input.usageLines,
    "",
    `Email setup: sending to ${input.cfg.to} through Resend (key ${input.cfg.apiKey ? "set" : "NOT set"}).`,
  ].join("\n");
  return { subject, text, needsAttention: attention.length };
}

async function usageLines(): Promise<string[]> {
  try {
    const gh = (await allUsage()).providers.find((p) => p.id === "github");
    if (!gh || gh.status !== "ok") return ["- minutes and cost: not measured (GitHub usage not connected)"];
    return gh.meters.map((m) => `- ${m.label}: ${m.used}${m.unit ? " " + m.unit : ""}${m.limit ? ` of ${m.limit}` : ""} (this month, not per day)`);
  } catch {
    return ["- minutes and cost: not measured"];
  }
}

export async function previewDigest(db: DB, now = new Date()): Promise<Digest & { configured: boolean }> {
  const cfg = alertConfigFromEnv();
  return { ...buildDigest(db, { now, ci: getCiSignal, usageLines: await usageLines(), cfg }), configured: !!cfg.apiKey };
}

function lastSent(db: DB): string | null {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(SENT_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Sends today's digest if it is due. Never throws. */
export async function digestTick(db: DB, now = new Date(), send: Sender = resendSender): Promise<"sent" | "not_due" | "not_configured" | "failed"> {
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < SEND_FROM_UTC_HOUR || lastSent(db) === day) return "not_due";
  const cfg = alertConfigFromEnv();
  // Record first so a retry loop cannot send twice in a day.
  db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SENT_KEY, day);
  if (!cfg.apiKey) {
    appendAudit(db, { actor: "digest", action: "digest.skipped", decision: "info", reason: "daily e-mail not configured (RESEND_API_KEY missing in Render)" });
    return "not_configured";
  }
  try {
    const d = buildDigest(db, { now, ci: getCiSignal, usageLines: await usageLines(), cfg });
    await send({ to: cfg.to, from: cfg.from, subject: d.subject, text: d.text, html: `<pre style="font:13px monospace">${d.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>` }, cfg.apiKey);
    appendAudit(db, { actor: "digest", action: "digest.sent", decision: "info", detail: { needsAttention: d.needsAttention } });
    return "sent";
  } catch (err) {
    appendAudit(db, { actor: "digest", action: "digest.failed", decision: "info", reason: (err as Error).message.slice(0, 200) });
    return "failed";
  }
}

export function startDailyDigest(db: DB): void {
  // First tick after the CI watch has had time to read GitHub.
  setTimeout(() => void digestTick(db), 2 * 60_000).unref();
  setInterval(() => void digestTick(db), 10 * 60_000).unref();
}
