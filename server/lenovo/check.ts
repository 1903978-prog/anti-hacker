/**
 * "Is the Lenovo (local Ollama) connected to this app?" check, one row per app.
 *
 * An app that does not use the Lenovo shows "not connected" (not a failure).
 * A connected app (compplan today) gets live checks through its Cloudflare
 * Access tunnel. Secrets are only read from secval's own environment
 * variables and are never stored, logged or returned.
 */

export type LenovoStatus = "not-connected" | "ok" | "alert" | "fail" | "not-measured";

export interface LenovoCheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "alert";
  detail: string;
}

export interface LenovoAppResult {
  app: string;
  status: LenovoStatus;
  summary: string;
  checkedAt: string | null;
  checks: LenovoCheckResult[];
}

export const LENOVO_APPS = ["compplan", "lm-op-model", "nexus", "10bonds", "eendigo", "secval"];
// compplan (Render), nexus and lm-op-model (Fly) all have Ollama code in their own repos (checked 03/11).
const DEFAULT_CONNECTED = ["compplan", "nexus", "lm-op-model"];
export const CHAT_ALERT_MS = 120_000;
const MODEL = "qwen3:8b";   // the only model allowed on the Lenovo (Livio, 04 Nov 2026)

export type LenovoFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface LenovoDeps {
  fetch?: LenovoFetch;
  now?: () => number;
  /** Connected app list (defaults to env LENOVO_CONNECTED_APPS, else compplan, nexus, lm-op-model). */
  connected?: string[];
  /** Policy gate (secval rule 5): asked before any request leaves secval. Refused = nothing is sent, "not measured". */
  approve?: (target: string) => { allowed: boolean; reason: string };
}

function refused(deps: LenovoDeps, url: string): string | null {
  if (!deps.approve) return null;
  let host = "";
  try { host = new URL(url).hostname; } catch { return "the address is not valid"; }
  const d = deps.approve(host);
  return d.allowed ? null : `secval's policy refused the check (${d.reason})`;
}

const realFetch: LenovoFetch = async (url, init) => {
  const r = await fetch(url, { ...init, redirect: "manual" });
  return { status: r.status, text: () => r.text() };
};

function missingVars(env: Record<string, string | undefined>): string[] {
  return [
    !(env.OLLAMA_BASE_URL ?? "").trim() && "OLLAMA_BASE_URL",
    !env.OLLAMA_CF_ACCESS_CLIENT_ID && "OLLAMA_CF_ACCESS_CLIENT_ID",
    !env.OLLAMA_CF_ACCESS_CLIENT_SECRET && "OLLAMA_CF_ACCESS_CLIENT_SECRET",
  ].filter(Boolean) as string[];
}

export function connectedApps(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.LENOVO_CONNECTED_APPS;
  if (!raw) return DEFAULT_CONNECTED;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function looksLikeOllama(text: string): boolean {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return typeof j === "object" && j !== null && ("version" in j || "message" in j || "models" in j);
  } catch {
    return false;
  }
}

export async function checkApp(
  app: string,
  env: Record<string, string | undefined> = process.env,
  deps: LenovoDeps = {},
): Promise<LenovoAppResult> {
  const connected = deps.connected ?? connectedApps(env);
  const checkedAt = new Date().toISOString();
  if (!connected.includes(app)) {
    return { app, status: "not-connected", summary: "Not connected to the Lenovo (not a failure).", checkedAt, checks: [] };
  }
  const f = deps.fetch ?? realFetch;
  const now = deps.now ?? Date.now;
  const checks: LenovoCheckResult[] = [];
  const add = (id: string, title: string, status: LenovoCheckResult["status"], detail: string) =>
    checks.push({ id, title, status, detail });

  const base = (env.OLLAMA_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const cid = env.OLLAMA_CF_ACCESS_CLIENT_ID ?? "";
  const secret = env.OLLAMA_CF_ACCESS_CLIENT_SECRET ?? "";
  const missing = [
    !base && "OLLAMA_BASE_URL",
    !cid && "OLLAMA_CF_ACCESS_CLIENT_ID",
    !secret && "OLLAMA_CF_ACCESS_CLIENT_SECRET",
  ].filter(Boolean) as string[];
  if (missing.length || !base.startsWith("https://")) {
    add(
      "env",
      "Connection settings are present",
      "alert",
      missing.length ? `Missing in secval: ${missing.join(", ")}.` : "OLLAMA_BASE_URL must start with https://.",
    );
    return { app, status: "alert", summary: checks[0]!.detail, checkedAt, checks };
  }
  add("env", "Connection settings are present", "pass", "All three variables are set.");
  const no = refused(deps, base);
  if (no) return { app, status: "not-measured", summary: `Not measured: ${no}.`, checkedAt, checks };

  const authHeaders = { "CF-Access-Client-Id": cid, "CF-Access-Client-Secret": secret };
  const attempt = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
    timeoutMs = 20_000,
  ) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(base + path, { method, headers, body, signal: ctl.signal });
      return { status: r.status, text: await r.text(), error: null as string | null };
    } catch {
      return { status: 0, text: "", error: "no answer (tunnel down or too slow)" };
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. With the token: Ollama answers with a version.
  const v = await attempt("GET", "/api/version", authHeaders);
  if (v.status === 200 && looksLikeOllama(v.text)) add("version", "Lenovo answers with the token", "pass", "GET /api/version returned 200 with a version.");
  else add("version", "Lenovo answers with the token", "alert", v.error ?? `GET /api/version returned ${v.status}; tunnel or token may be down.`);

  // 2. Without the token: login page or 403, never Ollama JSON.
  const open = await attempt("GET", "/api/version", {});
  if (open.error) add("closed", "Closed without the token", "alert", open.error);
  else if (open.status === 200 && looksLikeOllama(open.text)) add("closed", "Closed without the token", "fail", "Ollama answered WITHOUT the token. Anyone can reach the Lenovo. Fix Cloudflare Access now.");
  else add("closed", "Closed without the token", "pass", `Without the token the answer was ${open.status} (not Ollama).`);

  // 3. One real answer, timed.
  const t0 = now();
  const chat = await attempt(
    "POST",
    "/api/chat",
    { ...authHeaders, "content-type": "application/json" },
    JSON.stringify({ model: MODEL, stream: false, think: false, keep_alive: "30m", messages: [{ role: "user", content: "Say OK" }] }),
    CHAT_ALERT_MS + 5_000,
  );
  const ms = now() - t0;
  if (chat.error || chat.status !== 200) add("chat", "Lenovo gives an answer", "alert", chat.error ?? `POST /api/chat returned ${chat.status}.`);
  else if (ms > CHAT_ALERT_MS) add("chat", "Lenovo gives an answer", "alert", `Answered in ${Math.round(ms / 1000)} s (limit 120 s).`);
  else add("chat", "Lenovo gives an answer", "pass", `Answered in ${(ms / 1000).toFixed(1)} s.`);

  // 4. Downloading models must be blocked at the gateway.
  const pull = await attempt("POST", "/api/pull", { ...authHeaders, "content-type": "application/json" }, JSON.stringify({ model: "secval-probe-do-not-pull:0" }));
  if (pull.status === 403) add("pull", "Model downloads are blocked", "pass", "POST /api/pull returned 403.");
  else if (pull.error) add("pull", "Model downloads are blocked", "alert", pull.error);
  else add("pull", "Model downloads are blocked", "fail", `POST /api/pull returned ${pull.status}, expected 403.`);

  const status: LenovoStatus = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "alert") ? "alert" : "ok";
  const bad = checks.filter((c) => c.status !== "pass");
  const summary = status === "ok" ? "Connected and healthy." : bad.map((c) => c.detail).join(" ");
  return { app, status, summary, checkedAt, checks };
}

// --- Live question test (4/11/2026, Livio): each connected app is asked to send a real fixed question to the Lenovo through its own
// client, and the answer it got is shown per app. The app endpoint is fixed-prompt, rate limited and secret-protected (header
// x-lenovo-selftest = LENOVO_SELFTEST_TOKEN, else the Lenovo service secret). Only the answer text (max 200 chars) is kept; secrets never.
export const QUESTION = "What is the capital of Italy?";
export interface QuestionResult {
  app: string;
  question: string;
  answer: string;
  status: "ok" | "fail" | "not-measured";
  reason: string;
  ms: number | null;
  at: string | null;
}
const SELFTEST_URLS: Record<string, string> = {
  compplan: "https://compplan.onrender.com/api/lenovo-selftest",
  nexus: "https://nexus-eendigo.fly.dev/api/lenovo-selftest",
  "lm-op-model": "https://lm-op-model.fly.dev/api/lenovo-selftest",
};
const lastQ = new Map<string, QuestionResult>();

export async function askApp(app: string, env: Record<string, string | undefined>, deps: LenovoDeps = {}): Promise<QuestionResult> {
  const f = deps.fetch ?? realFetch;
  const at = new Date().toISOString();
  const mk = (status: QuestionResult["status"], reason: string, answer = "", ms: number | null = null): QuestionResult => ({ app, question: QUESTION, answer, status, reason, ms, at });
  const token = env.LENOVO_SELFTEST_TOKEN || env.OLLAMA_CF_ACCESS_CLIENT_SECRET || "";
  if (!token) return mk("not-measured", "Missing in secval: LENOVO_SELFTEST_TOKEN (or OLLAMA_CF_ACCESS_CLIENT_SECRET).");
  const url = SELFTEST_URLS[app];
  if (!url) return mk("not-measured", "No test address for this app.");
  const no = refused(deps, url);
  if (no) return mk("not-measured", `Not measured: ${no}.`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 75_000);
  const t0 = (deps.now ?? Date.now)();
  try {
    const r = await f(url, { method: "POST", headers: { "x-lenovo-selftest": token, "content-type": "application/json" }, body: "{}", signal: ctl.signal });
    const text = await r.text();
    if (r.status === 404) return mk("not-measured", "The app does not have the test yet (HTTP 404): the new version is not deployed.");
    if (r.status === 503) return mk("not-measured", "The app has no test token set (HTTP 503).");
    if (r.status === 401 || r.status === 403) return mk("fail", `The app refused secval's test token (HTTP ${r.status}): the token differs between secval and the app.`);
    if (r.status === 429) return mk("not-measured", "Asked too soon after the last test (HTTP 429): try again in 20 seconds.");
    if (r.status !== 200) return mk("fail", `The app answered HTTP ${r.status}.`);
    let j: Record<string, unknown>;
    try { j = JSON.parse(text) as Record<string, unknown>; } catch { return mk("fail", "The app's reply was not readable."); }
    const answer = String(j.answer ?? "").slice(0, 200);
    const ms = typeof j.ms === "number" ? j.ms : (deps.now ?? Date.now)() - t0;
    return j.ok === true ? mk("ok", "", answer, ms) : mk("fail", String(j.reason ?? "no reason given").slice(0, 200), answer, ms);
  } catch {
    return mk("fail", "No answer from the app (down, asleep or too slow).");
  } finally {
    clearTimeout(timer);
  }
}

export function questionOverview(env: Record<string, string | undefined> = process.env, connected = connectedApps(env)): QuestionResult[] {
  return connected.filter((a) => LENOVO_APPS.includes(a)).map((app) =>
    lastQ.get(app) ?? { app, question: QUESTION, answer: "", status: "not-measured" as const, reason: "not measured", ms: null, at: null });
}

export async function runQuestionTests(env: Record<string, string | undefined> = process.env, deps: LenovoDeps = {}): Promise<QuestionResult[]> {
  const connected = deps.connected ?? connectedApps(env);
  await Promise.all(connected.filter((a) => LENOVO_APPS.includes(a)).map(async (app) => { lastQ.set(app, await askApp(app, env, deps)); }));
  return questionOverview(env, connected);
}

// Live checks cost a real model answer, so they run on demand (button or
// nightly), and the page shows the last result; before any run: not measured.
const last = new Map<string, LenovoAppResult>();

export function lenovoOverview(env: Record<string, string | undefined> = process.env, connected = connectedApps(env)): LenovoAppResult[] {
  return LENOVO_APPS.map((app) => {
    if (!connected.includes(app)) {
      return { app, status: "not-connected" as const, summary: "Not connected to the Lenovo (not a failure).", checkedAt: null, checks: [] };
    }
    const prev = last.get(app);
    if (prev) return prev;
    // No network call yet, but missing keys are already known: say so.
    const missing = missingVars(env);
    if (missing.length) {
      return { app, status: "alert" as const, summary: `Missing in secval: ${missing.join(", ")}.`, checkedAt: null, checks: [] };
    }
    return { app, status: "not-measured" as const, summary: "not measured", checkedAt: null, checks: [] };
  });
}

export async function runLenovoChecks(
  env: Record<string, string | undefined> = process.env,
  deps: LenovoDeps = {},
): Promise<LenovoAppResult[]> {
  const connected = deps.connected ?? connectedApps(env);
  for (const app of connected) {
    if (LENOVO_APPS.includes(app)) last.set(app, await checkApp(app, env, { ...deps, connected }));
  }
  await runQuestionTests(env, { ...deps, connected });
  return lenovoOverview(env, connected);
}

export function resetLenovoCache(): void {
  last.clear();
  lastQ.clear();
  passiveAt.clear();
  badStreak.clear();
}

/** Which tracked app a dashboard host belongs to (10bonds.com -> 10bonds, nexus-eendigo.fly.dev -> nexus). */
export function lenovoForHost(
  host: string,
  env: Record<string, string | undefined> = process.env,
): { status: LenovoStatus; summary: string } {
  const label = host.toLowerCase().split(".")[0]!;
  const app = LENOVO_APPS.find((a) => label === a || label.startsWith(a));
  if (!app) return { status: "not-connected", summary: "Not connected to the Lenovo." };
  let r = lenovoOverview(env).find((x) => x.app === app)!;
  const q = lastQ.get(app);
  // A real answer from the Lenovo in the last 30 minutes outranks a passive "failing" reading (the app's in-memory health
  // record can say offline after one missed call even though questions still get answered).
  if ((r.status === "alert" || r.status === "fail") && q?.status === "ok" && q.at && (deps_now() - Date.parse(q.at)) < RECENT_ANSWER_MS && !r.checks.length) {
    r = { ...r, status: "ok", summary: `Answered a real question at ${q.at.slice(11, 16)} UTC; the app's own status says: ${r.summary}` };
  }
  const qText = !q || q.status === "not-measured" ? "" : q.status === "ok" ? ` Test question "${q.question}" answered: "${q.answer}" (${((q.ms ?? 0) / 1000).toFixed(1)} s).` : ` Test question failed: ${q.reason}`;
  return { status: r.status, summary: r.summary + qText };
}

// Passive status (no model call, no secrets): a connected app that publishes a Lenovo health block on its public /api/version
// (compplan does: verdict + plain sentence) is read from there. This runs lazily when the dashboard or the Lenovo list is
// requested and the last reading is older than 5 minutes (no timer), so the column never stays "not measured" until someone
// presses the button. A full check (button) is kept for 1 hour before the passive reading may replace it.
const VERSION_URLS: Record<string, string> = {
  compplan: "https://compplan.onrender.com/api/version",
  nexus: "https://nexus-eendigo.fly.dev/api/version",
  "lm-op-model": "https://lm-op-model.fly.dev/api/version",
};
const PASSIVE_EVERY_MS = 5 * 60_000, FULL_KEEP_MS = 60 * 60_000, BAD_RECHECK_MS = 60_000;
export const RECENT_ANSWER_MS = 30 * 60_000;
const deps_now = () => Date.now();
const badStreak = new Map<string, number>();
const passiveAt = new Map<string, number>();

export function verdictToStatus(verdict: unknown): LenovoStatus {
  if (verdict === "online") return "ok";
  if (verdict === "offline") return "fail";
  if (verdict === "gateway_down_worker_up" || verdict === "ollama_down_on_lenovo") return "alert";
  return "not-measured";
}

export async function refreshPassive(
  env: Record<string, string | undefined> = process.env,
  deps: LenovoDeps = {},
): Promise<void> {
  const connected = deps.connected ?? connectedApps(env);
  const f = deps.fetch ?? realFetch;
  const now = (deps.now ?? Date.now)();
  await Promise.all(connected.filter((a) => VERSION_URLS[a] && LENOVO_APPS.includes(a)).map(async (app) => {
    const every = badStreak.get(app) ? BAD_RECHECK_MS : PASSIVE_EVERY_MS;
    if (now - (passiveAt.get(app) ?? 0) < every) return;
    passiveAt.set(app, now);
    const full = last.get(app);
    if (full?.checks.length && full.checkedAt && now - Date.parse(full.checkedAt) < FULL_KEEP_MS) return;
    const no = refused(deps, VERSION_URLS[app]!);
    if (no) { last.set(app, { app, status: "not-measured", summary: `Not measured: ${no}.`, checkedAt: new Date(now).toISOString(), checks: [] }); return; }
    const read = async (): Promise<LenovoAppResult> => {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8_000);
      const at = new Date(now).toISOString();
      try {
        const r = await f(VERSION_URLS[app]!, { method: "GET", headers: {}, signal: ctl.signal });
        const j = JSON.parse(await r.text()) as { lenovo?: { verdict?: unknown; say?: unknown } };
        if (r.status !== 200 || !j.lenovo) return { app, status: "not-measured", summary: `The app's /api/version has no Lenovo block (HTTP ${r.status}).`, checkedAt: at, checks: [] };
        return { app, status: verdictToStatus(j.lenovo.verdict), summary: String(j.lenovo.say ?? j.lenovo.verdict ?? "").slice(0, 300), checkedAt: at, checks: [] };
      } catch {
        return { app, status: "not-measured", summary: "Could not read the app's /api/version just now.", checkedAt: at, checks: [] };
      } finally { clearTimeout(timer); }
    };
    const isBad = (x: LenovoAppResult) => x.status === "alert" || x.status === "fail";
    let res = await read();
    if (isBad(res)) { const again = await read(); if (!isBad(again)) res = again; } // retry once right away
    const prev = last.get(app);
    if (isBad(res)) {
      const n = (badStreak.get(app) ?? 0) + 1;
      badStreak.set(app, n);
      // One bad reading in a row is not shown as failing: keep the last good reading (with its time) until a second one.
      if (n < 2 && prev && prev.status === "ok") {
        last.set(app, { ...prev, summary: `${prev.summary.replace(/ \(last good.*$/, "")} (last good ${prev.checkedAt?.slice(11, 16) ?? "?"} UTC; one miss just now, rechecking)` });
        return;
      }
    } else badStreak.delete(app);
    last.set(app, res);
  }));
}
