import type { DB } from "../db.js";
import { listAllowlist } from "../ownership/allowlist.js";
import { requestApproval } from "../governance/policy.js";
import { httpProbe as realHttp } from "../scan/probes.js";
import type { HttpProbe } from "../scan/types.js";

/** How often each proven app's home page is checked. */
export const UPTIME_EVERY_MS = 30 * 60_000;
const CHECK_TIMEOUT_MS = 10_000;

export interface UptimeCheck {
  host: string;
  ts: string;
  ok: boolean;
  status: number | null;
  ms: number | null;
  error: string | null;
  /** Hosting provider recognised from response headers, if any. */
  provider: string | null;
}

/** Recognises the hosting provider from response headers (names only). */
export function detectProvider(headers: Record<string, string>): string | null {
  if (headers["fly-request-id"] || /fly/i.test(headers["server"] ?? "")) return "Fly.io";
  if (headers["rndr-id"] || headers["x-render-origin-server"]) return "Render";
  if (headers["x-vercel-id"]) return "Vercel";
  if (headers["x-nf-request-id"]) return "Netlify";
  if (headers["x-github-request-id"]) return "GitHub Pages";
  if (headers["cf-ray"]) return "Cloudflare";
  return null;
}

/**
 * Checks one app's home page with a single GET. Like every scan it must pass
 * the policy gate first (passive mode), so unproven or blocked hosts and an
 * engaged kill switch mean nothing is sent. Only status and timing are kept.
 */
export async function checkUptime(
  db: DB,
  target: string,
  actor = "uptime",
  probe: HttpProbe = realHttp,
): Promise<UptimeCheck | null> {
  const decision = requestApproval(db, { actor, target, mode: "passive" });
  if (!decision.allowed || !decision.host) return null;
  const host = decision.host;

  const started = Date.now();
  let check: UptimeCheck;
  try {
    const res = await probe(`https://${host}/`, CHECK_TIMEOUT_MS);
    check = {
      host,
      ts: new Date().toISOString(),
      ok: res.status < 400,
      status: res.status,
      ms: Date.now() - started,
      error: null,
      provider: detectProvider(res.headers),
    };
  } catch (err) {
    check = {
      host,
      ts: new Date().toISOString(),
      ok: false,
      status: null,
      ms: null,
      error: (err as Error).message.slice(0, 200),
      provider: null,
    };
  }

  db.prepare(
    `INSERT INTO uptime_checks (host, ts, ok, status, ms, error, provider) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(check.host, check.ts, check.ok ? 1 : 0, check.status, check.ms, check.error, check.provider);
  return check;
}

/** Checks every ownership-proven app once. */
export async function checkAllUptime(db: DB, probe: HttpProbe = realHttp): Promise<UptimeCheck[]> {
  const out: UptimeCheck[] = [];
  for (const e of listAllowlist(db).filter((e) => e.ownershipProven)) {
    const c = await checkUptime(db, e.domain, "uptime", probe);
    if (c) out.push(c);
  }
  return out;
}

/** Uptime checks for a host since a given time, oldest first. */
export function listUptime(db: DB, host: string, sinceIso: string): UptimeCheck[] {
  const rows = db
    .prepare(`SELECT * FROM uptime_checks WHERE host = ? AND ts >= ? ORDER BY ts`)
    .all(host, sinceIso) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    host: r.host as string,
    ts: r.ts as string,
    ok: Number(r.ok) === 1,
    status: (r.status as number) ?? null,
    ms: (r.ms as number) ?? null,
    error: (r.error as string) ?? null,
    provider: (r.provider as string) ?? null,
  }));
}

/** Starts the in-process uptime checker. Returns a stopper. */
export function startUptimeChecker(db: DB): () => void {
  const run = () => void checkAllUptime(db).catch(() => {
    /* a failed round must not crash the server */
  });
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, UPTIME_EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
