import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

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
const SESSION_DAYS = 180;

/**
 * The browser session value: derived from the API token, so it survives a
 * restart (the free tier sleeps) and stops working the moment the token is
 * changed. The token itself never leaves the server after sign-in.
 */
export function sessionValue(token: string): string {
  return createHmac("sha256", token).update("secval-session-v1").digest("base64url");
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
 * no script on the page can read it. POST /session checks the token; POST
 * /session/end signs out. Mounted under /api, before apiAuth.
 */
export function sessionRoutes(token: string | undefined, limiter: FailedAuthLimiter) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();
    if (req.path === "/session/end") {
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
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
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionValue(token)}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
    );
    res.json({ signedIn: true });
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
export function apiAuth(token: string | undefined, limiter?: FailedAuthLimiter) {
  const session = token ? sessionValue(token) : "";
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
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
    if (!provided && cookie && constantTimeEqual(cookie, session)) {
      const origin = req.get("origin");
      const changes = req.method !== "GET" && req.method !== "HEAD";
      // Render's proxy keeps the Host header; X-Forwarded-Host is accepted too
      // in case a proxy rewrites it. A browser cannot set either cross-site.
      const own = [req.get("host"), req.get("x-forwarded-host")];
      if (changes && origin && !own.some((h) => sameHost(origin, h))) {
        return res.status(403).json({ error: "cross-site request refused" });
      }
      return next();
    }
    if (provided || cookie) {
      if (limiter?.blocked()) return tooManyTries(res);
      limiter?.fail();
    }
    return res.status(401).json({ error: "unauthorized" });
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
