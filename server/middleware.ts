import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { DB } from "./db.js";
import { appendAudit } from "./audit/log.js";

/**
 * Security hardening middleware for secval's OWN HTTP surface. None of this
 * touches the governance layer; it protects the control plane (the API that
 * can start scans, change the allowlist, and toggle the kill switch).
 */

/** Sets strong security headers on every response (so secval passes its own checks). */
export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        // Inline styles only; inline/eval scripts are disallowed.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    next();
  };
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/**
 * A small in-memory fixed-window rate limiter keyed by client IP. Enough to
 * blunt abuse of the control plane on a single instance; not a distributed
 * limiter. Fails open only on a missing IP (never a reason to 500).
 */
export function rateLimit({ windowMs, max }: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = Date.now() + windowMs;
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    // Forget expired windows now and then, so a flood of addresses cannot
    // grow the map without bound.
    if (now >= nextSweep) {
      for (const [k, e] of hits) if (now >= e.resetAt) hits.delete(k);
      nextSweep = now + windowMs;
    }
    const key = req.ip ?? "unknown";
    let entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(retry, 1)));
      return res.status(429).json({ error: "rate limit exceeded" });
    }
    next();
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const SESSION_COOKIE = "secval_session";
/** A sign-in lasts 30 days from the moment the token was pasted; using the page does not extend it. */
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;
/** Allowed clock difference for a sign-in time slightly in the future. */
const SKEW_MS = 5 * 60_000;
const REVOKED_KEY = "session_revoked";
const VALID_AFTER_KEY = "session_valid_after";

/** Where a sign-out is remembered, and the clock (tests pass a fake one). */
export interface SessionDeps {
  db?: DB;
  now?: () => number;
}

/**
 * The signing key for sign-ins. Derived from the API token, so it survives a
 * restart or deploy (nothing to store), and changing the token on Render ends
 * every sign-in at once. The token itself never leaves the server.
 */
function sessionKey(token: string): Buffer {
  return createHmac("sha256", token).update("secval-session-v2").digest();
}

function mac(token: string, body: string): string {
  return createHmac("sha256", sessionKey(token)).update(body).digest("base64url");
}

/** A new signed sign-in: "v2.<issued ms>.<random id>.<signature>". */
export function issueSession(token: string, issuedAt: number): string {
  const body = `v2.${issuedAt.toString(36)}.${randomBytes(16).toString("base64url")}`;
  return `${body}.${mac(token, body)}`;
}

type Check =
  | { ok: true; id: string; issuedAt: number }
  | { ok: false; reason: "expired" | "signed-out" | "token-changed" };

/** Reads a v2 cookie: right signature, not older than 30 days, not signed out. */
export function checkSession(token: string, value: string, deps: SessionDeps = {}): Check {
  const now = (deps.now ?? Date.now)();
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return { ok: false, reason: "token-changed" };
  const body = parts.slice(0, 3).join(".");
  if (!constantTimeEqual(parts[3] ?? "", mac(token, body))) return { ok: false, reason: "token-changed" };
  const issuedAt = parseInt(parts[1] ?? "", 36);
  const id = parts[2] ?? "";
  if (!Number.isFinite(issuedAt) || issuedAt > now + SKEW_MS) return { ok: false, reason: "token-changed" };
  if (now >= issuedAt + SESSION_MS) return { ok: false, reason: "expired" };
  if (deps.db) {
    // Fail closed: if the sign-out records cannot be read, no cookie is accepted.
    const after = validAfter(deps.db);
    const revoked = revokedIds(deps.db, now);
    if (after === null || revoked === null || issuedAt <= after || revoked.has(id)) {
      return { ok: false, reason: "signed-out" };
    }
  }
  return { ok: true, id, issuedAt };
}

function readState(db: DB, key: string): string | undefined {
  return (db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
}

function writeState(db: DB, key: string, value: string): void {
  db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** 0 when never set; null when the stored value is unreadable (treated as "signed out"). */
function validAfter(db: DB): number | null {
  const raw = readState(db, VALID_AFTER_KEY);
  if (raw === undefined) return 0;
  const v = Number(raw);
  return raw.trim() !== "" && Number.isFinite(v) ? v : null;
}

/** Signed-out sign-in ids, each kept until its own 30 days would have ended. */
/** null when the stored list is unreadable (treated as "signed out"). */
function revokedList(db: DB, now: number): { id: string; until: number }[] | null {
  try {
    const list = JSON.parse(readState(db, REVOKED_KEY) ?? "[]") as { id: string; until: number }[];
    if (!Array.isArray(list)) return null;
    return list.filter((r) => typeof r?.id === "string" && typeof r.until === "number" && r.until > now);
  } catch {
    return null;
  }
}

function revokedIds(db: DB, now: number): Set<string> | null {
  const list = revokedList(db, now);
  return list ? new Set(list.map((r) => r.id)) : null;
}

const MAX_REVOKED = 500;

/** Ends one sign-in on the server too, so a copied cookie stops working. */
function revokeSession(db: DB, id: string, issuedAt: number, now: number): void {
  const list = revokedList(db, now) ?? [];
  list.push({ id, until: issuedAt + SESSION_MS });
  // Never forget a sign-out to save space: past the cap, end every sign-in instead.
  if (list.length > MAX_REVOKED) {
    writeState(db, VALID_AFTER_KEY, String(now));
    writeState(db, REVOKED_KEY, "[]");
  } else {
    writeState(db, REVOKED_KEY, JSON.stringify(list));
  }
}

/** Security sign-out: every sign-in made before now stops working, in every browser. */
export function revokeAllSessions(db: DB, now: number): void {
  writeState(db, VALID_AFTER_KEY, String(now));
  // Every earlier sign-in is now ended anyway, so the per-browser list can start
  // fresh (this also repairs an unreadable list, which otherwise refuses all).
  writeState(db, REVOKED_KEY, "[]");
  appendAudit(db, { actor: "owner", action: "session.revoke_all", decision: "info", reason: "every browser sign-in ended" });
}

function setSessionCookie(res: Response, value: string, maxAgeSeconds: number): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

function readCookie(req: Request, name: string): string {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/**
 * Counts wrong tokens across all callers (the caller's address can be faked,
 * so it is not used). Past the limit, further wrong tokens get 429; a correct
 * token always gets through, so guessing cannot lock the owner out.
 */
export function failedAuthLimiter({ windowMs, max }: RateLimitOptions) {
  let count = 0;
  let resetAt = 0;
  return {
    blocked(now = Date.now()): boolean {
      if (now >= resetAt) {
        count = 0;
        resetAt = now + windowMs;
      }
      return count >= max;
    },
    fail(now = Date.now()): void {
      if (now >= resetAt) {
        count = 0;
        resetAt = now + windowMs;
      }
      count++;
    },
  };
}
export type FailedAuthLimiter = ReturnType<typeof failedAuthLimiter>;

function tooManyTries(res: Response): Response {
  res.setHeader("Retry-After", "60");
  return res.status(429).json({ error: "too many wrong tokens; wait a minute" });
}

/**
 * Sign-in for the web page: swaps the secret token for an HttpOnly cookie, so
 * no script on the page can read it. POST /session checks the token and starts
 * a 30-day sign-in; POST /session/end signs this browser out (on the server
 * too). Mounted under /api, before apiAuth.
 */
export function sessionRoutes(token: string | undefined, limiter: FailedAuthLimiter, deps: SessionDeps = {}) {
  const now = deps.now ?? Date.now;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();
    if (req.path === "/session/end") {
      const cookie = readCookie(req, SESSION_COOKIE);
      if (token && cookie && deps.db) {
        const c = checkSession(token, cookie, deps);
        if (c.ok) revokeSession(deps.db, c.id, c.issuedAt, now());
      }
      clearSessionCookie(res);
      return res.json({ signedIn: false });
    }
    if (req.path !== "/session") return next();
    if (!token) {
      return res
        .status(503)
        .json({ error: "API token not configured; set SECVAL_API_TOKEN to enable the API" });
    }
    const provided = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const ok = !!provided && constantTimeEqual(provided, token);
    if (!ok) {
      if (limiter.blocked()) return tooManyTries(res);
      limiter.fail();
      return res.status(401).json({ error: "wrong token" });
    }
    setSessionCookie(res, issueSession(token, now()), SESSION_MS / 1000);
    res.json({ signedIn: true, days: SESSION_DAYS });
  };
}

/**
 * Requires the API token for every API request, reads included: the allowlist,
 * audit trail, scan findings and dashboard are private too. Accepts either a
 * bearer token (scripts) or the sign-in cookie (the web page). A cookie-signed
 * change must come from secval's own page (Origin check), on top of the
 * cookie's SameSite=Strict. Only CORS preflights (OPTIONS) pass through. Fails
 * closed: if no token is configured, every request is refused, so the control
 * plane is never silently left open.
 */
/**
 * Per-app write-only tokens, from "app=token,app2=token2". Each opens only
 * POST /api/quality/validate, and only for its own app (checked by the route).
 */
export function parseAppTokens(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const i = part.indexOf("=");
    const app = part.slice(0, i).trim().toLowerCase();
    const tok = part.slice(i + 1).trim();
    if (i > 0 && app && tok.length >= 24) out.set(app, tok);
  }
  return out;
}

export function apiAuth(
  token: string | undefined,
  limiter?: FailedAuthLimiter,
  appTokens: Map<string, string> = new Map(),
  deps: SessionDeps = {},
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "")?.[1]?.trim() ?? "";
    if (bearer && req.method === "POST" && req.path === "/quality/validate") {
      for (const [app, t] of appTokens) {
        if (constantTimeEqual(bearer, t)) {
          res.locals.qualityApp = app;
          return next();
        }
      }
    }
    if (!token) {
      return res
        .status(503)
        .json({ error: "API token not configured; set SECVAL_API_TOKEN to enable the API" });
    }
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match?.[1]?.trim() ?? "";
    if (provided && constantTimeEqual(provided, token)) return next();
    const cookie = readCookie(req, SESSION_COOKIE);
    let reason = provided ? "wrong-token" : cookie ? "token-changed" : "not-signed-in";
    if (!provided && cookie) {
      const c = checkSession(token, cookie, deps);
      // Pre-30-day cookies (one fixed value per token, no end date) are not
      // accepted: they could never be signed out, so they need one new sign-in.
      if (c.ok) {
        const origin = req.get("origin");
        const changes = req.method !== "GET" && req.method !== "HEAD";
        // Render's proxy keeps the Host header; X-Forwarded-Host is accepted too
        // in case a proxy rewrites it. A browser cannot set either cross-site.
        const own = [req.get("host"), req.get("x-forwarded-host")];
        if (changes && origin && !own.some((h) => sameHost(origin, h))) {
          return res.status(403).json({ error: "cross-site request refused" });
        }
        // The 30 days count from sign-in: a valid cookie is not renewed.
        return next();
      }
      reason = c.reason;
    }
    if (provided || reason === "token-changed") {
      if (limiter?.blocked()) return tooManyTries(res);
      limiter?.fail();
    }
    // Say why, so the page can tell the owner whether the browser lost its
    // sign-in, the 30 days ran out, it was signed out, or the token was changed.
    if (cookie && !provided) clearSessionCookie(res);
    return res.status(401).json({ error: "unauthorized", reason });
  };
}

function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Stops browsers and proxies from keeping copies of private API answers. */
export function noStore() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}
