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
const DEFAULT_CONNECTED = ["compplan"];
export const CHAT_ALERT_MS = 120_000;
const MODEL = "qwen3.5:2b";

export type LenovoFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface LenovoDeps {
  fetch?: LenovoFetch;
  now?: () => number;
  /** Connected app list (defaults to env LENOVO_CONNECTED_APPS, else compplan). */
  connected?: string[];
}

const realFetch: LenovoFetch = async (url, init) => {
  const r = await fetch(url, { ...init, redirect: "manual" });
  return { status: r.status, text: () => r.text() };
};

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
    JSON.stringify({ model: MODEL, stream: false, think: false, messages: [{ role: "user", content: "Say OK" }] }),
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

// Live checks cost a real model answer, so they run on demand (button or
// nightly), and the page shows the last result; before any run: not measured.
const last = new Map<string, LenovoAppResult>();

export function lenovoOverview(env: Record<string, string | undefined> = process.env, connected = connectedApps(env)): LenovoAppResult[] {
  return LENOVO_APPS.map((app) => {
    if (!connected.includes(app)) {
      return { app, status: "not-connected" as const, summary: "Not connected to the Lenovo (not a failure).", checkedAt: null, checks: [] };
    }
    return last.get(app) ?? { app, status: "not-measured" as const, summary: "not measured", checkedAt: null, checks: [] };
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
  return lenovoOverview(env, connected);
}

export function resetLenovoCache(): void {
  last.clear();
}

/** Which tracked app a dashboard host belongs to (10bonds.com -> 10bonds, nexus-eendigo.fly.dev -> nexus). */
export function lenovoForHost(
  host: string,
  env: Record<string, string | undefined> = process.env,
): { status: LenovoStatus; summary: string } {
  const label = host.toLowerCase().split(".")[0]!;
  const app = LENOVO_APPS.find((a) => label === a || label.startsWith(a));
  if (!app) return { status: "not-connected", summary: "Not connected to the Lenovo." };
  const r = lenovoOverview(env).find((x) => x.app === app)!;
  return { status: r.status, summary: r.summary };
}
