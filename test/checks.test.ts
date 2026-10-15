import { describe, it, expect } from "vitest";
import { analyzeHeaders, analyzeCookies, analyzeTls } from "../server/scan/checks.js";
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
      "strict-transport-security": "max-age=63072000",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=()",
    });
    expect(analyzeHeaders(http)).toHaveLength(0);
  });

  it("flags software version disclosure", () => {
    const codes = analyzeHeaders(bareHttp({ server: "nginx/1.25.1" })).map((f) => f.code);
    expect(codes).toContain("version-disclosure");
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
