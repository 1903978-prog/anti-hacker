import { timingSafeEqual } from "node:crypto";
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
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
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

/**
 * Requires a bearer API token for state-changing requests (POST/PUT/PATCH/
 * DELETE). Read-only requests (GET/HEAD) pass through. Fails closed: if no
 * token is configured, every state-changing request is refused, so the control
 * plane is never silently left open.
 */
export function apiAuth(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return next();
    }
    if (!token) {
      return res
        .status(503)
        .json({ error: "API token not configured; set SECVAL_API_TOKEN to enable changes" });
    }
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match?.[1]?.trim() ?? "";
    if (!provided || !constantTimeEqual(provided, token)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  };
}
