/**
 * Lenovo 24/7 monitor (Livio's P0 directive, 12 Nov 2026).
 *
 * Independent of the Lenovo: secval asks each app what it has really seen, on
 * a fixed cadence, and keeps every reading. Five levels per app:
 *   1 Lenovo host          last contact from the machine (shared row "lenovo")
 *   2 Infrastructure       Ollama, gateway/tunnel, worker processes (shared row)
 *   3 Authentication       the app's own credentials are accepted
 *   4 Application          the app's own connection to the Lenovo is up
 *   5 Business transaction a real, bounded answer or completed job through the
 *                          app's own execution path
 * A shared-gateway reading is never copied into another app's row: every app
 * row comes from that app's own endpoint.
 *
 * Every probe goes through the policy engine (passive mode) first, like every
 * other request secval sends: an unproven host or an engaged kill switch means
 * nothing is sent and the reading is "not measured". Only status, timing and a
 * short plain reason are kept; never an answer beyond 200 characters, never a
 * secret.
 */
import type { DB } from "../db.js";
import { requestApproval } from "../governance/policy.js";
import { appendAudit } from "../audit/log.js";
import { alertConfigFromEnv, resendSender, type AlertConfig, type Sender } from "../notify/alerts.js";

export type Level = 1 | 2 | 3 | 4 | 5;
export const LEVELS: Level[] = [1, 2, 3, 4, 5];
export const LEVEL_NAMES: Record<Level, string> = {
  1: "Lenovo host",
  2: "Infrastructure",
  3: "Authentication",
  4: "Application connection",
  5: "Business transaction",
};

/** The shared machine row plus every app that may use the Lenovo. */
export const MONITOR_ROWS = ["lenovo", "compplan", "nexus", "lm-op-model", "10bonds"] as const;
export type MonitorRow = (typeof MONITOR_ROWS)[number];

/** Which levels exist for which row. Anything else is shown "not applicable". */
export const APPLIES: Record<MonitorRow, Level[]> = {
  lenovo: [1, 2],
  compplan: [3, 4, 5],
  nexus: [3, 4, 5],
  "lm-op-model": [3, 4, 5],
  "10bonds": [3, 4, 5],
};

export interface Sample {
  app: MonitorRow;
  level: Level;
  /** true = healthy, false = failing, null = not measured (does not count either way). */
  ok: boolean | null;
  ms: number | null;
  detail: string;
}

export type MonitorFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

const realFetch: MonitorFetch = async (url, init) => {
  const r = await fetch(url, { ...init, redirect: "manual" });
  return { status: r.status, text: () => r.text() };
};

export interface Probe {
  id: string;
  host: string;
  everyMs: number;
  /** What the probe can report; used to mark a refused probe "not measured" on every level it covers. */
  covers: Array<{ app: MonitorRow; level: Level }>;
  run: (f: MonitorFetch, env: Record<string, string | undefined>) => Promise<Sample[]>;
}

export const MINUTE = 60_000;
const UA = { "user-agent": "secval-lenovo-monitor/1.0" };

async function get(f: MonitorFetch, url: string, timeoutMs: number, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await f(url, { method: init.method ?? "GET", headers: { ...UA, ...(init.headers ?? {}) }, body: init.body, signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, text, ms: Date.now() - t0, error: null as string | null };
  } catch {
    return { status: 0, text: "", ms: Date.now() - t0, error: "no answer (down, asleep or too slow)" };
  } finally {
    clearTimeout(timer);
  }
}

function json(text: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const short = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").slice(0, 200);

/** Reads an app's public /api/version Lenovo block (verdict + sentence; compplan adds gateway and worker detail). */
export function versionProbe(app: Exclude<MonitorRow, "lenovo" | "10bonds">, host: string): Probe {
  const covers: Probe["covers"] = [{ app, level: 4 }];
  if (app === "compplan") covers.push({ app: "lenovo", level: 1 }, { app: "lenovo", level: 2 });
  return {
    id: `${app}-version`,
    host,
    everyMs: MINUTE,
    covers,
    run: async (f) => {
      const r = await get(f, `https://${host}/api/version`, 15_000);
      const j = json(r.text);
      const lenovo = (j?.lenovo ?? null) as Record<string, unknown> | null;
      if (r.status !== 200 || !lenovo) {
        const why = r.error ?? (r.status !== 200 ? `the app answered HTTP ${r.status}` : "the app's /api/version has no Lenovo block");
        // The app itself being down is not proof the Lenovo is down: not measured.
        return covers.map((c) => ({ ...c, ok: null, ms: r.ms, detail: `Not measured: ${why}.` }));
      }
      const verdict = String(lenovo.verdict ?? "unknown");
      const say = short(lenovo.say);
      const out: Sample[] = [{
        app, level: 4, ms: r.ms, detail: `${verdict}: ${say}`,
        ok: verdict === "online" ? true : verdict === "unknown" ? null : false,
      }];
      if (app === "compplan") {
        const w = (lenovo.worker ?? null) as Record<string, unknown> | null;
        const g = (lenovo.gateway ?? null) as Record<string, unknown> | null;
        const wAge = typeof w?.seen_age_s === "number" ? w.seen_age_s : null;
        const gAge = typeof g?.ok_age_s === "number" ? g.ok_age_s : null;
        // Level 1: the machine itself made contact recently (the helper polls every <= 15 s; a gateway answer counts too).
        const contact = (wAge !== null && wAge < 90) || (gAge !== null && gAge < 600);
        const seen = wAge !== null || gAge !== null;
        out.push({
          app: "lenovo", level: 1, ms: r.ms,
          ok: contact ? true : seen ? false : null,
          detail: contact
            ? `Last contact from the Lenovo ${Math.min(wAge ?? Infinity, gAge ?? Infinity)} s ago (as seen by compplan).`
            : seen ? `No contact from the Lenovo: helper ${wAge ?? "never"} s, gateway ${gAge ?? "never"} s ago.` : "Not measured: compplan has had no contact since it started.",
        });
        // Level 2: Ollama answers on the machine and the gateway/tunnel carries traffic.
        const infraBad = verdict === "ollama_down_on_lenovo" || verdict === "gateway_down_worker_up" || w?.ollama_ok === false;
        out.push({
          app: "lenovo", level: 2, ms: r.ms,
          ok: infraBad || verdict === "offline" ? false : verdict === "online" ? true : null,
          detail: `${verdict}: ${say}${g?.last_problem ? ` Last gateway problem: ${short(g.last_problem)}` : ""}`,
        });
      }
      return out;
    },
  };
}

/** 10bonds: the public worker status (no secrets): connected, done last hour, queue. */
export function tenBondsProbe(host = "10bonds.com"): Probe {
  return {
    id: "10bonds-status",
    host,
    // The status route reads 10bonds' database; every 5 minutes keeps that cost small while the worker is down
    // (while it runs, its own claim every minute keeps the database awake anyway).
    everyMs: 5 * MINUTE,
    covers: [{ app: "10bonds", level: 3 }, { app: "10bonds", level: 4 }, { app: "10bonds", level: 5 }],
    run: async (f) => {
      const r = await get(f, `https://${host}/api/credit-worker/status`, 20_000);
      const j = json(r.text);
      if (r.status !== 200 || !j) {
        const why = r.error ?? `the site answered HTTP ${r.status}`;
        return [3, 4, 5].map((level) => ({ app: "10bonds" as const, level: level as Level, ok: null, ms: r.ms, detail: `Not measured: ${why}.` }));
      }
      const connected = j.connected === true;
      const ago = typeof j.lastSeenSecondsAgo === "number" ? j.lastSeenSecondsAgo : null;
      const done1h = Number(j.jobsDoneLastHour ?? 0), queued = Number(j.queued ?? 0), processing = Number(j.processing ?? 0);
      const agoText = ago === null ? "never" : ago < 3600 ? `${ago} s ago` : `${Math.round(ago / 3600)} h ago`;
      // The worker exits on a rejected token, so "connected" also proves its token is accepted.
      return [
        { app: "10bonds", level: 3, ms: r.ms, ok: connected ? true : null, detail: connected ? "Worker token accepted (worker is claiming jobs)." : "Not measured: worker not connected, so its token cannot be judged." },
        { app: "10bonds", level: 4, ms: r.ms, ok: connected, detail: `Worker ${connected ? "connected" : "NOT connected"}, last seen ${agoText}${j.version ? `, version ${short(j.version)}` : ""}.` },
        {
          app: "10bonds", level: 5, ms: r.ms,
          ok: done1h > 0 || (queued === 0 && processing === 0),
          detail: `${done1h} jobs done in the last hour, ${queued} queued, ${processing} processing.`,
        },
      ];
    },
  };
}

/** Level 3 + 5 for a gateway app: the app sends one fixed question to the Lenovo through its own client. */
export function selftestProbe(app: "compplan" | "nexus" | "lm-op-model", host: string): Probe {
  return {
    id: `${app}-selftest`,
    host,
    everyMs: 5 * MINUTE,
    covers: [{ app, level: 3 }, { app, level: 5 }],
    run: async (f, env) => {
      const token = env.LENOVO_SELFTEST_TOKEN || env.OLLAMA_CF_ACCESS_CLIENT_SECRET || "";
      const nm = (why: string, ms: number | null = null): Sample[] => [3, 5].map((level) => ({ app, level: level as Level, ok: null, ms, detail: `Not measured: ${why}` }));
      if (!token) return nm("LENOVO_SELFTEST_TOKEN is not set in secval.");
      const r = await get(f, `https://${host}/api/lenovo-selftest`, 75_000, {
        method: "POST", headers: { "x-lenovo-selftest": token, "content-type": "application/json" }, body: "{}",
      });
      if (r.error) return nm(`${r.error}.`, r.ms);
      if (r.status === 401 || r.status === 403) {
        return [
          { app, level: 3, ok: false, ms: r.ms, detail: `The app refused secval's test token (HTTP ${r.status}).` },
          { app, level: 5, ok: null, ms: r.ms, detail: "Not measured: the test was refused." },
        ];
      }
      if (r.status === 404) return nm("the app has no self-test route deployed (HTTP 404).", r.ms);
      if (r.status === 503) return nm("the app has no self-test token configured (HTTP 503).", r.ms);
      if (r.status === 429) return nm("asked too soon after the last test (HTTP 429).", r.ms);
      const j = json(r.text);
      if (r.status !== 200 || !j) return [
        { app, level: 3, ok: null, ms: r.ms, detail: `Not measured: the app answered HTTP ${r.status}.` },
        { app, level: 5, ok: false, ms: r.ms, detail: `The self-test answered HTTP ${r.status}.` },
      ];
      const ms = typeof j.ms === "number" ? j.ms : r.ms;
      return [
        { app, level: 3, ok: true, ms: r.ms, detail: "Test token accepted." },
        { app, level: 5, ok: j.ok === true, ms, detail: j.ok === true ? `Answered "${short(j.answer).slice(0, 80)}" in ${(ms / 1000).toFixed(1)} s.` : `Test question failed: ${short(j.reason) || "no reason given"}.` },
      ];
    },
  };
}

export function defaultProbes(): Probe[] {
  return [
    versionProbe("compplan", "compplan.onrender.com"),
    versionProbe("nexus", "nexus-eendigo.fly.dev"),
    versionProbe("lm-op-model", "lm-op-model.fly.dev"),
    tenBondsProbe(),
    // Self-tests run one after another (see runDue), never three model calls at once on the Lenovo.
    selftestProbe("compplan", "compplan.onrender.com"),
    selftestProbe("nexus", "nexus-eendigo.fly.dev"),
    selftestProbe("lm-op-model", "lm-op-model.fly.dev"),
  ];
}

// --- Storage ------------------------------------------------------------------

export function recordSamples(db: DB, probe: string, ts: string, samples: Sample[]): void {
  const ins = db.prepare(`INSERT INTO lenovo_samples (ts, app, level, probe, ok, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const s of samples) ins.run(ts, s.app, s.level, probe, s.ok === null ? null : s.ok ? 1 : 0, s.ms, s.detail.slice(0, 300));
  })();
}

/** Samples are bounded: readings older than this are removed (alerts are kept). */
export const SAMPLE_RETENTION_DAYS = 90;
export function pruneSamples(db: DB, now = new Date()): number {
  const cut = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 86_400_000).toISOString();
  return db.prepare(`DELETE FROM lenovo_samples WHERE ts < ?`).run(cut).changes;
}

// --- Alerts -------------------------------------------------------------------

export type AlertStatus = "ok" | "warning" | "critical";
export interface AlertState { status: AlertStatus; fails: number; firstFailTs: string | null; oks: number }
export const FRESH_STATE: AlertState = { status: "ok", fails: 0, firstFailTs: null, oks: 0 };
/** Warning after this many failed checks in a row. */
export const WARN_AFTER = 2;
/** Critical once failures have lasted this long (and at least WARN_AFTER checks failed). */
export const CRITICAL_AFTER_MS = 5 * MINUTE;
/** Recovered after this many good checks in a row. */
export const RECOVER_AFTER = 3;

export type Transition = "warning" | "critical" | "recovered" | null;

/** Pure: next alert state for one reading. "Not measured" readings change nothing. */
export function nextState(prev: AlertState, ok: boolean | null, ts: string): { state: AlertState; transition: Transition } {
  if (ok === null) return { state: prev, transition: null };
  if (!ok) {
    const fails = prev.fails + 1;
    const firstFailTs = prev.firstFailTs ?? ts;
    let status = prev.status;
    let transition: Transition = null;
    const lasted = Date.parse(ts) - Date.parse(firstFailTs);
    if (status !== "critical" && fails >= WARN_AFTER && lasted >= CRITICAL_AFTER_MS) { status = "critical"; transition = "critical"; }
    else if (status === "ok" && fails >= WARN_AFTER) { status = "warning"; transition = "warning"; }
    return { state: { status, fails, firstFailTs, oks: 0 }, transition };
  }
  if (prev.status === "ok") return { state: { ...FRESH_STATE }, transition: null };
  const oks = prev.oks + 1;
  if (oks >= RECOVER_AFTER) return { state: { ...FRESH_STATE }, transition: "recovered" };
  return { state: { ...prev, oks }, transition: null };
}

const states = new Map<string, AlertState>();
const key = (app: string, level: number) => `${app}#${level}`;
export function alertState(app: string, level: number): AlertState {
  return states.get(key(app, level)) ?? FRESH_STATE;
}

/** Rebuilds the in-memory alert states from the stored readings (after a restart). */
export function restoreStates(db: DB, now = new Date()): void {
  states.clear();
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const rows = db.prepare(`SELECT ts, app, level, ok FROM lenovo_samples WHERE ts >= ? AND ok IS NOT NULL ORDER BY ts, id`).all(since) as Array<{ ts: string; app: string; level: number; ok: number }>;
  for (const r of rows) states.set(key(r.app, r.level), nextState(alertState(r.app, r.level), r.ok === 1, r.ts).state);
}

/** At most one critical e-mail per row and level in this window. */
export const CRITICAL_MAIL_GAP_MS = 6 * 3_600_000;

export interface AlertDeps { cfg?: AlertConfig; send?: Sender; now?: () => Date }

async function mail(subject: string, text: string, deps: AlertDeps): Promise<boolean> {
  const cfg = deps.cfg ?? alertConfigFromEnv();
  if (!cfg.apiKey) return false;
  try {
    const html = `<pre style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`;
    await (deps.send ?? resendSender)({ to: cfg.to, from: cfg.from, subject, html, text }, cfg.apiKey);
    return true;
  } catch {
    return false;
  }
}

function lastCriticalMail(db: DB, app: string, level: number): string | null {
  const r = db.prepare(`SELECT ts FROM lenovo_alerts WHERE app = ? AND level = ? AND state = 'critical' AND emailed = 1 ORDER BY id DESC LIMIT 1`).get(app, level) as { ts: string } | undefined;
  return r?.ts ?? null;
}

/** Applies a probe's readings to the alert states; records and mails transitions. */
export async function applyAlerts(db: DB, ts: string, samples: Sample[], deps: AlertDeps = {}): Promise<Array<{ app: string; level: Level; transition: Exclude<Transition, null> }>> {
  const out: Array<{ app: string; level: Level; transition: Exclude<Transition, null> }> = [];
  for (const s of samples) {
    const { state, transition } = nextState(alertState(s.app, s.level), s.ok, ts);
    states.set(key(s.app, s.level), state);
    if (!transition) continue;
    out.push({ app: s.app, level: s.level, transition });
    const label = `${s.app === "lenovo" ? "Lenovo (shared)" : s.app}, level ${s.level} ${LEVEL_NAMES[s.level]}`;
    let emailed = false;
    if (transition === "critical") {
      const prev = lastCriticalMail(db, s.app, s.level);
      if (!prev || Date.parse(ts) - Date.parse(prev) >= CRITICAL_MAIL_GAP_MS) {
        emailed = await mail(`secval: Lenovo CRITICAL - ${label}`, `${label} has failed for 5 minutes or more.\n\nLast reading (${ts.slice(0, 16).replace("T", " ")} UTC): ${s.detail}\n\nsecval keeps checking and will write again when it has recovered.`, deps);
      }
    } else if (transition === "recovered") {
      const wasMailed = lastCriticalMail(db, s.app, s.level);
      if (wasMailed) emailed = await mail(`secval: Lenovo recovered - ${label}`, `${label} is healthy again (${RECOVER_AFTER} good checks in a row).\n\nLast reading (${ts.slice(0, 16).replace("T", " ")} UTC): ${s.detail}`, deps);
    }
    db.prepare(`INSERT INTO lenovo_alerts (ts, app, level, state, detail, emailed) VALUES (?, ?, ?, ?, ?, ?)`).run(ts, s.app, s.level, transition, s.detail.slice(0, 300), emailed ? 1 : 0);
    appendAudit(db, { actor: "lenovo-monitor", action: `lenovo.${transition}`, target: s.app, decision: "allow", reason: `${label}: ${s.detail.slice(0, 200)}` });
  }
  return out;
}

// --- Running ------------------------------------------------------------------

const lastRun = new Map<string, number>();
let running = false;

/** Runs one probe through the policy gate; a refused probe records "not measured" on every level it covers. */
export async function runProbe(db: DB, probe: Probe, env: Record<string, string | undefined> = process.env, f: MonitorFetch = realFetch, deps: AlertDeps = {}): Promise<Sample[]> {
  const ts = (deps.now?.() ?? new Date()).toISOString();
  const decision = requestApproval(db, { actor: "lenovo-monitor", target: probe.host, mode: "passive" });
  let samples: Sample[];
  if (!decision.allowed) {
    samples = probe.covers.map((c) => ({ ...c, ok: null, ms: null, detail: `Not measured: secval's policy refused the check (${decision.reason}).` }));
  } else {
    try {
      samples = await probe.run(f, env);
    } catch (e) {
      samples = probe.covers.map((c) => ({ ...c, ok: null, ms: null, detail: `Not measured: probe error ${short((e as Error)?.message)}.` }));
    }
  }
  recordSamples(db, probe.id, ts, samples);
  await applyAlerts(db, ts, samples, deps);
  return samples;
}

/** Runs every probe that is due, one at a time (never two model calls at once on the Lenovo). */
export async function runDue(db: DB, probes: Probe[] = defaultProbes(), env: Record<string, string | undefined> = process.env, f: MonitorFetch = realFetch, deps: AlertDeps = {}): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const now = (deps.now?.() ?? new Date()).getTime();
    for (const p of probes) {
      // A 10 s tolerance so a 60 s tick never skips a 60 s probe.
      if (now - (lastRun.get(p.id) ?? 0) < p.everyMs - 10_000) continue;
      lastRun.set(p.id, now);
      await runProbe(db, p, env, f, deps);
      n++;
    }
  } finally {
    running = false;
  }
  return n;
}

export function resetMonitor(): void {
  lastRun.clear();
  states.clear();
  running = false;
}

// --- Reporting ----------------------------------------------------------------

export interface Uptime { ok: number; fail: number; notMeasured: number; pct: number | null }

export function uptime(db: DB, app: string, level: number, sinceIso: string): Uptime {
  const r = db.prepare(
    `SELECT SUM(ok = 1) ok, SUM(ok = 0) fail, SUM(ok IS NULL) nm FROM lenovo_samples WHERE app = ? AND level = ? AND ts >= ?`,
  ).get(app, level, sinceIso) as { ok: number | null; fail: number | null; nm: number | null };
  const ok = r.ok ?? 0, fail = r.fail ?? 0;
  return { ok, fail, notMeasured: r.nm ?? 0, pct: ok + fail ? Math.round((10000 * ok) / (ok + fail)) / 100 : null };
}

export interface MatrixCell {
  level: Level;
  name: string;
  applies: boolean;
  last: { ts: string; ok: boolean | null; ms: number | null; detail: string } | null;
  alert: AlertStatus;
  uptime24h: Uptime;
  uptime7d: Uptime;
  uptime30d: Uptime;
}

export function matrix(db: DB, now = new Date()): Array<{ app: MonitorRow; cells: MatrixCell[] }> {
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  return MONITOR_ROWS.map((app) => ({
    app,
    cells: LEVELS.map((level) => {
      const applies = APPLIES[app].includes(level);
      const row = applies
        ? (db.prepare(`SELECT ts, ok, ms, detail FROM lenovo_samples WHERE app = ? AND level = ? ORDER BY ts DESC, id DESC LIMIT 1`).get(app, level) as { ts: string; ok: number | null; ms: number | null; detail: string } | undefined)
        : undefined;
      const empty: Uptime = { ok: 0, fail: 0, notMeasured: 0, pct: null };
      return {
        level,
        name: LEVEL_NAMES[level],
        applies,
        last: row ? { ts: row.ts, ok: row.ok === null ? null : row.ok === 1, ms: row.ms, detail: row.detail } : null,
        alert: applies ? alertState(app, level).status : "ok",
        uptime24h: applies ? uptime(db, app, level, ago(1)) : empty,
        uptime7d: applies ? uptime(db, app, level, ago(7)) : empty,
        uptime30d: applies ? uptime(db, app, level, ago(30)) : empty,
      };
    }),
  }));
}

/** Plain-text daily (1 day) or weekly (7 days) reliability summary. "Not measured" is said, never hidden. */
export function summaryText(db: DB, days: 1 | 7, now = new Date()): string {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const lines = [`Lenovo reliability, last ${days === 1 ? "24 hours" : "7 days"} (to ${now.toISOString().slice(0, 16).replace("T", " ")} UTC). Target: 99% measured, design 99.9%.`, ""];
  for (const app of MONITOR_ROWS) {
    lines.push(app === "lenovo" ? "Lenovo (shared machine)" : app);
    for (const level of APPLIES[app]) {
      const u = uptime(db, app, level, since);
      const pct = u.pct === null ? "not measured" : `${u.pct.toFixed(2)}% (${u.ok} good, ${u.fail} failed)`;
      lines.push(`  ${level} ${LEVEL_NAMES[level]}: ${pct}${u.notMeasured ? `, ${u.notMeasured} readings not measured` : ""}`);
    }
  }
  const alerts = db.prepare(`SELECT ts, app, level, state FROM lenovo_alerts WHERE ts >= ? ORDER BY ts`).all(since) as Array<{ ts: string; app: string; level: number; state: string }>;
  lines.push("", alerts.length ? `Alerts (${alerts.length}):` : "Alerts: none.");
  for (const a of alerts) lines.push(`  ${a.ts.slice(0, 16).replace("T", " ")} ${a.app} level ${a.level}: ${a.state}`);
  return lines.join("\n");
}

const REPORT_KEY = (k: string) => `lenovo_report_${k}`;
function getSetting(db: DB, k: string): string | null {
  const r = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(k) as { value: string } | undefined;
  return r?.value ?? null;
}
function setSetting(db: DB, k: string, v: string): void {
  db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
}

/** Daily summary from 07:00 UTC, weekly report on Mondays; each at most once per day/week. Mail only if mail is configured. */
export async function reportTick(db: DB, deps: AlertDeps = {}): Promise<"none" | "daily" | "weekly" | "both"> {
  const now = deps.now?.() ?? new Date();
  if (now.getUTCHours() < 7) return "none";
  const day = now.toISOString().slice(0, 10);
  let sent: "none" | "daily" | "weekly" | "both" = "none";
  if (getSetting(db, REPORT_KEY("daily")) !== day) {
    setSetting(db, REPORT_KEY("daily"), day);
    if (await mail(`secval: Lenovo daily uptime ${day}`, summaryText(db, 1, now), deps)) sent = "daily";
  }
  if (now.getUTCDay() === 1 && getSetting(db, REPORT_KEY("weekly")) !== day) {
    setSetting(db, REPORT_KEY("weekly"), day);
    if (await mail(`secval: Lenovo weekly reliability report ${day}`, summaryText(db, 7, now), deps)) sent = sent === "daily" ? "both" : "weekly";
  }
  return sent;
}

/**
 * On demand only (Livio, 12 Nov 2026: "stop checks per minute, check must run only when I press refresh button").
 * Runs every probe once, one at a time, through the policy gate, and stores the readings. It sends no e-mail
 * and writes no alert: alerts need repeated readings over time, which on-demand checks do not give.
 * Nothing in secval calls this on a timer; only the Refresh button (POST /api/lenovo/matrix/refresh) does.
 */
export async function refreshNow(db: DB, probes: Probe[] = defaultProbes(), env: Record<string, string | undefined> = process.env, f: MonitorFetch = realFetch, deps: AlertDeps = {}): Promise<number | "busy"> {
  if (running) return "busy";
  running = true;
  let n = 0;
  try {
    for (const p of probes) {
      const ts = (deps.now?.() ?? new Date()).toISOString();
      const decision = requestApproval(db, { actor: "lenovo-monitor", target: p.host, mode: "passive" });
      let samples: Sample[];
      if (!decision.allowed) {
        samples = p.covers.map((c) => ({ ...c, ok: null, ms: null, detail: `Not measured: secval's policy refused the check (${decision.reason}).` }));
      } else {
        try { samples = await p.run(f, env); } catch (e) {
          samples = p.covers.map((c) => ({ ...c, ok: null, ms: null, detail: `Not measured: probe error ${short((e as Error)?.message)}.` }));
        }
      }
      recordSamples(db, p.id, ts, samples);
      n++;
    }
    try { pruneSamples(db, deps.now?.() ?? new Date()); } catch { /* next refresh */ }
  } finally {
    running = false;
  }
  return n;
}
