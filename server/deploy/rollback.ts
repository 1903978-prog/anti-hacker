/**
 * One-click rollback of secval itself on Render: lists the recent deploys and
 * starts a rollback to an earlier one that was live before.
 *
 * The Render API key comes from RENDER_API_KEY and the service id from
 * RENDER_SERVICE_ID (Render sets that one on every service). Neither is
 * stored, logged or sent to the browser; Render error bodies are not passed
 * on, only the status code. Without the key the feature shows "not connected".
 *
 * A rollback only reuses an earlier build; it does not change settings. Per
 * Render's docs the API rollback leaves auto-deploy on, so the next push to
 * integration deploys again (after CI passes).
 */

export interface DeployInfo {
  id: string;
  status: string;
  commit: string;
  message: string;
  createdAt: string;
  /** True for the deploy that is live right now. */
  current: boolean;
  /** True when a rollback to this deploy is allowed. */
  canRollBack: boolean;
}

export type RollbackStatus = "ok" | "not-connected" | "error";

export interface DeployList {
  status: RollbackStatus;
  message: string;
  deploys: DeployInfo[];
  link: string;
}

export interface RenderResponse {
  status: number;
  json(): Promise<unknown>;
}
export type RenderFetcher = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
) => Promise<RenderResponse>;

type Env = Record<string, string | undefined>;

const TIMEOUT_MS = 15_000;
const realFetch: RenderFetcher = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Deploy ids look like dep-xxxxxxxx; anything else is refused before it reaches Render. */
const DEPLOY_ID = /^dep-[A-Za-z0-9]{6,40}$/;
const SERVICE_ID = /^srv-[A-Za-z0-9]{6,40}$/;
/** A deploy that was live at some point can be rolled back to. */
const WAS_LIVE = new Set(["live", "deactivated"]);

function dashboardLink(serviceId: string): string {
  return serviceId ? `https://dashboard.render.com/web/${serviceId}/deploys` : "https://dashboard.render.com";
}

function connection(env: Env): { headers: Record<string, string>; serviceId: string } | null {
  const key = env.RENDER_API_KEY;
  const serviceId = env.RENDER_SERVICE_ID ?? "";
  if (!key || !SERVICE_ID.test(serviceId)) return null;
  return { headers: { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/json" }, serviceId };
}

export async function listDeploys(env: Env = process.env, f: RenderFetcher = realFetch): Promise<DeployList> {
  const conn = connection(env);
  if (!conn) {
    return {
      status: "not-connected",
      message: "Not connected. Needs RENDER_API_KEY in secval's Render settings (RENDER_SERVICE_ID is set by Render itself).",
      deploys: [],
      link: dashboardLink(""),
    };
  }
  const link = dashboardLink(conn.serviceId);
  try {
    const res = await f(`https://api.render.com/v1/services/${conn.serviceId}/deploys?limit=10`, { method: "GET", headers: conn.headers });
    if (res.status < 200 || res.status >= 300) {
      return { status: "error", message: `Render answered ${res.status}. Check the key in RENDER_API_KEY.`, deploys: [], link };
    }
    const body = await res.json();
    const rows = (Array.isArray(body) ? body : []).map((r) => obj(obj(r).deploy ?? r));
    let liveSeen = false;
    const deploys: DeployInfo[] = rows.map((d) => {
      const status = str(d.status);
      const commit = obj(d.commit);
      const current = status === "live" && !liveSeen;
      if (status === "live") liveSeen = true;
      return {
        id: str(d.id),
        status,
        commit: str(commit.id).slice(0, 7),
        message: (str(commit.message).split("\n")[0] ?? "").slice(0, 120),
        createdAt: str(d.createdAt),
        current,
        canRollBack: !current && WAS_LIVE.has(status) && DEPLOY_ID.test(str(d.id)),
      };
    });
    return { status: "ok", message: "Connected to Render.", deploys, link };
  } catch {
    return { status: "error", message: "Could not reach Render.", deploys: [], link };
  }
}

export interface RollbackResult {
  ok: boolean;
  message: string;
  deploy?: DeployInfo;
}

/** Rolls back to `deployId` only if it is in the recent list and allowed. */
export async function rollbackTo(
  deployId: string,
  env: Env = process.env,
  f: RenderFetcher = realFetch,
): Promise<RollbackResult> {
  const conn = connection(env);
  if (!conn) return { ok: false, message: "Not connected to Render." };
  if (!DEPLOY_ID.test(deployId)) return { ok: false, message: "That is not a deploy id." };
  const list = await listDeploys(env, f);
  if (list.status !== "ok") return { ok: false, message: list.message };
  const target = list.deploys.find((d) => d.id === deployId);
  if (!target) return { ok: false, message: "That deploy is not in the recent list." };
  if (target.current) return { ok: false, message: "That deploy is already live.", deploy: target };
  if (!target.canRollBack) return { ok: false, message: "That deploy was never live, so it cannot be rolled back to.", deploy: target };
  try {
    const res = await f(`https://api.render.com/v1/services/${conn.serviceId}/rollback`, {
      method: "POST",
      headers: conn.headers,
      body: JSON.stringify({ deployId }),
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, message: `Render refused the rollback (${res.status}).`, deploy: target };
    }
    return { ok: true, message: "Rollback started. Render is switching to that build; secval restarts in about a minute.", deploy: target };
  } catch {
    return { ok: false, message: "Could not reach Render.", deploy: target };
  }
}
