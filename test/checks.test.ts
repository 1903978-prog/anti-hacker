import { describe, it, expect } from "vitest";
import {
  analyzeHeaders,
  analyzeCookies,
  analyzeTls,
  analyzeHttpRedirect,
  analyzeHttpMethods,
} from "../server/scan/checks.js";
import type { HttpResult, TlsResult } from "../server/scan/types.js";

const bareHttp = (headers: Record<string, string> = {}, setCookies: string[] = []): HttpResult => ({
  status: 200,
  headers,
  setCookies,
});

describe("header checks", () => {
  it("flags all missing headers on a bare response", () => {
    const codes = analyzeHeaders(bareHttp()).map((f) => f.code);
    expect(codes).toContain("missing-hsts");
    expect(codes).toContain("missing-csp");
    expect(codes).toContain("missing-xcto");
    expect(codes).toContain("missing-framing-protection");
  });

  it("is quiet when headers are well set", () => {
    const http = bareHttp({
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=()",
      "cross-origin-opener-policy": "same-origin",
    });
    expect(analyzeHeaders(http)).toHaveLength(0);
  });

  it("flags software version disclosure", () => {
    const codes = analyzeHeaders(bareHttp({ server: "nginx/1.25.1" })).map((f) => f.code);
    expect(codes).toContain("version-disclosure");
  });

  it("flags a short HSTS max-age and missing includeSubDomains", () => {
    const codes = analyzeHeaders(bareHttp({ "strict-transport-security": "max-age=3600" })).map(
      (f) => f.code,
    );
    expect(codes).toContain("weak-hsts-max-age");
    expect(codes).toContain("hsts-no-subdomains");
  });

  it("flags a weak CSP using unsafe-inline", () => {
    const codes = analyzeHeaders(
      bareHttp({ "content-security-policy": "default-src 'self' 'unsafe-inline'" }),
    ).map((f) => f.code);
    expect(codes).toContain("weak-csp");
  });

  it("flags missing COOP", () => {
    expect(analyzeHeaders(bareHttp()).map((f) => f.code)).toContain("missing-coop");
  });

  it("flags wildcard CORS, and escalates with credentials", () => {
    expect(analyzeHeaders(bareHttp({ "access-control-allow-origin": "*" })).map((f) => f.code)).toContain(
      "cors-wildcard",
    );
    const withCreds = analyzeHeaders(
      bareHttp({ "access-control-allow-origin": "*", "access-control-allow-credentials": "true" }),
    ).map((f) => f.code);
    expect(withCreds).toContain("cors-wildcard-credentials");
  });
});

describe("cookie checks", () => {
  it("ignores the cookie value and flags missing attributes", () => {
    const findings = analyzeCookies(["sid=supersecretvalue; Path=/"]);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("cookie-not-secure");
    expect(codes).toContain("cookie-not-httponly");
    expect(codes).toContain("cookie-no-samesite");
    // No finding detail should contain the cookie's value.
    expect(findings.every((f) => !f.detail.includes("supersecretvalue"))).toBe(true);
  });

  it("is quiet for a hardened cookie", () => {
    expect(analyzeCookies(["sid=x; Path=/; Secure; HttpOnly; SameSite=Lax"])).toHaveLength(0);
  });

  it("flags SameSite=None without Secure", () => {
    const codes = analyzeCookies(["sid=x; Path=/; HttpOnly; SameSite=None"]).map((f) => f.code);
    expect(codes).toContain("cookie-samesite-none-insecure");
  });
});

describe("plain-HTTP redirect check", () => {
  const http = (status: number, headers: Record<string, string> = {}): HttpResult => ({
    status,
    headers,
    setCookies: [],
  });

  it("flags content served over plain HTTP", () => {
    expect(analyzeHttpRedirect(http(200))?.code).toBe("no-https-redirect");
  });

  it("flags an HTTP redirect that does not target HTTPS", () => {
    expect(analyzeHttpRedirect(http(301, { location: "http://example.com/" }))?.code).toBe(
      "http-redirect-not-https",
    );
  });

  it("is quiet when HTTP redirects to HTTPS", () => {
    expect(analyzeHttpRedirect(http(301, { location: "https://example.com/" }))).toBeNull();
  });
});

describe("HTTP methods check", () => {
  it("flags TRACE and advertised write methods", () => {
    const codes = analyzeHttpMethods("GET, POST, PUT, TRACE, OPTIONS").map((f) => f.code);
    expect(codes).toContain("http-trace-enabled");
    expect(codes).toContain("http-write-methods-advertised");
  });

  it("is quiet for a read-only method set", () => {
    expect(analyzeHttpMethods("GET, HEAD, OPTIONS")).toHaveLength(0);
  });

  it("returns nothing when no Allow header is present", () => {
    expect(analyzeHttpMethods(undefined)).toHaveLength(0);
  });
});

describe("tls checks", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const good: TlsResult = { protocol: "TLSv1.3", validTo: "2026-06-01T00:00:00Z", authorized: true };

  it("passes a good handshake", () => {
    expect(analyzeTls(good, now)).toHaveLength(0);
  });

  it("flags a failed handshake", () => {
    expect(analyzeTls({ protocol: null, validTo: null, authorized: false }, now)[0]?.code).toBe(
      "tls-handshake-failed",
    );
  });

  it("flags outdated TLS and untrusted certs", () => {
    const codes = analyzeTls(
      { protocol: "TLSv1.1", validTo: "2026-06-01T00:00:00Z", authorized: false },
      now,
    ).map((f) => f.code);
    expect(codes).toContain("tls-outdated");
    expect(codes).toContain("tls-cert-invalid");
  });

  it("flags an expired certificate", () => {
    const codes = analyzeTls({ ...good, validTo: "2025-12-01T00:00:00Z" }, now).map((f) => f.code);
    expect(codes).toContain("tls-cert-expired");
  });

  it("warns when a certificate is expiring soon", () => {
    const codes = analyzeTls({ ...good, validTo: "2026-01-10T00:00:00Z" }, now).map((f) => f.code);
    expect(codes).toContain("tls-cert-expiring");
  });
});
