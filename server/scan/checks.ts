import type { Finding, HttpResult, Severity, TlsResult } from "./types.js";

/**
 * Pure analysis functions. They take normalized probe results and return
 * findings. They never see or retain response bodies — only header/cert
 * metadata is inspected, and only the conclusion is kept.
 */

export function analyzeHeaders(http: HttpResult): Finding[] {
  const h = http.headers;
  const findings: Finding[] = [];

  if (!h["strict-transport-security"]) {
    findings.push({
      severity: "medium",
      code: "missing-hsts",
      title: "HSTS header missing",
      detail: "Strict-Transport-Security is not set; browsers may allow downgrade to HTTP.",
    });
  }

  if (!h["content-security-policy"]) {
    findings.push({
      severity: "medium",
      code: "missing-csp",
      title: "Content-Security-Policy missing",
      detail: "No CSP header; reduces defense against content injection and XSS.",
    });
  }

  if ((h["x-content-type-options"] ?? "").toLowerCase() !== "nosniff") {
    findings.push({
      severity: "low",
      code: "missing-xcto",
      title: "X-Content-Type-Options not 'nosniff'",
      detail: "Browsers may MIME-sniff responses, a minor injection risk.",
    });
  }

  const hasFrameAncestors = /frame-ancestors/i.test(h["content-security-policy"] ?? "");
  if (!h["x-frame-options"] && !hasFrameAncestors) {
    findings.push({
      severity: "low",
      code: "missing-framing-protection",
      title: "No clickjacking protection",
      detail: "Neither X-Frame-Options nor CSP frame-ancestors is set.",
    });
  }

  if (!h["referrer-policy"]) {
    findings.push({
      severity: "low",
      code: "missing-referrer-policy",
      title: "Referrer-Policy missing",
      detail: "Referrer-Policy is not set; referrer data may leak to other origins.",
    });
  }

  if (!h["permissions-policy"]) {
    findings.push({
      severity: "info",
      code: "missing-permissions-policy",
      title: "Permissions-Policy missing",
      detail: "Permissions-Policy is not set; browser features are not restricted.",
    });
  }

  // Version/software disclosure (the presence is the finding; we do not keep
  // the value beyond naming which header disclosed it).
  for (const header of ["server", "x-powered-by"]) {
    const value = h[header];
    if (value && /\d/.test(value)) {
      findings.push({
        severity: "info",
        code: "version-disclosure",
        title: `Software version disclosed via '${header}'`,
        detail: `The '${header}' response header reveals software/version details.`,
      });
    }
  }

  return findings;
}

export function analyzeCookies(setCookies: string[]): Finding[] {
  const findings: Finding[] = [];
  let insecure = 0;
  let noHttpOnly = 0;
  let noSameSite = 0;

  for (const cookie of setCookies) {
    // Drop the first segment (name=value) so we never inspect cookie data;
    // only the attribute tokens after it are examined.
    const attrTokens = cookie
      .split(";")
      .slice(1)
      .map((t) => t.trim().toLowerCase());
    const has = (name: string) => attrTokens.some((t) => t === name || t.startsWith(name + "="));
    if (!has("secure")) insecure++;
    if (!has("httponly")) noHttpOnly++;
    if (!has("samesite")) noSameSite++;
  }

  if (insecure > 0) {
    findings.push({
      severity: "medium",
      code: "cookie-not-secure",
      title: "Cookie without Secure flag",
      detail: `${insecure} cookie(s) are set without the Secure attribute.`,
    });
  }
  if (noHttpOnly > 0) {
    findings.push({
      severity: "low",
      code: "cookie-not-httponly",
      title: "Cookie without HttpOnly flag",
      detail: `${noHttpOnly} cookie(s) are set without HttpOnly.`,
    });
  }
  if (noSameSite > 0) {
    findings.push({
      severity: "low",
      code: "cookie-no-samesite",
      title: "Cookie without SameSite attribute",
      detail: `${noSameSite} cookie(s) have no SameSite attribute.`,
    });
  }
  return findings;
}

export function analyzeTls(tls: TlsResult, now: Date = new Date()): Finding[] {
  const findings: Finding[] = [];

  if (!tls.protocol) {
    findings.push({
      severity: "high",
      code: "tls-handshake-failed",
      title: "TLS handshake failed",
      detail: "Could not complete a TLS handshake with the host.",
    });
    return findings;
  }

  const version = parseTlsVersion(tls.protocol);
  if (version !== null && version < 1.2) {
    findings.push({
      severity: "high",
      code: "tls-outdated",
      title: `Outdated TLS version (${tls.protocol})`,
      detail: "The server negotiated a TLS version below 1.2.",
    });
  }

  if (!tls.authorized) {
    findings.push({
      severity: "high",
      code: "tls-cert-invalid",
      title: "Certificate not trusted",
      detail: `Certificate chain was not authorized${tls.authorizationError ? ` (${tls.authorizationError})` : ""}.`,
    });
  }

  if (tls.validTo) {
    const expiry = new Date(tls.validTo);
    const days = Math.floor((expiry.getTime() - now.getTime()) / 86_400_000);
    if (days < 0) {
      findings.push({
        severity: "high",
        code: "tls-cert-expired",
        title: "Certificate expired",
        detail: `The certificate expired ${Math.abs(days)} day(s) ago.`,
      });
    } else if (days < 21) {
      findings.push({
        severity: "medium",
        code: "tls-cert-expiring",
        title: "Certificate expiring soon",
        detail: `The certificate expires in ${days} day(s).`,
      });
    }
  }

  return findings;
}

function parseTlsVersion(protocol: string): number | null {
  const m = /TLSv(\d+(?:\.\d+)?)/i.exec(protocol);
  return m ? Number(m[1]) : null;
}

/**
 * A sensitive path probed by the active scanner. The probe is a single
 * read-only GET; exposure is judged from the HTTP status only. Response
 * bodies are never read or retained, so a positive finding records that a
 * path is reachable — never what it contained.
 */
export interface SensitivePath {
  path: string;
  code: string;
  title: string;
  severity: Severity;
  detail: string;
}

/**
 * A small, curated set of commonly-leaked paths. Kept deliberately short so
 * an active scan stays polite (well within the request caps) and never
 * resembles brute-force enumeration. All are read-only GETs.
 */
export const SENSITIVE_PATHS: SensitivePath[] = [
  {
    path: "/.git/config",
    code: "exposed-git",
    title: "Git repository exposed",
    severity: "high",
    detail: "A /.git/ directory is reachable; source code and history may be downloadable.",
  },
  {
    path: "/.env",
    code: "exposed-env",
    title: "Environment file exposed",
    severity: "high",
    detail: "A /.env file is reachable; such files often hold secrets and credentials.",
  },
  {
    path: "/.svn/entries",
    code: "exposed-svn",
    title: "Subversion metadata exposed",
    severity: "high",
    detail: "A /.svn/ directory is reachable; source metadata may be downloadable.",
  },
  {
    path: "/backup.sql",
    code: "exposed-db-backup",
    title: "Database backup exposed",
    severity: "high",
    detail: "A backup.sql file is reachable; it may contain a full database dump.",
  },
  {
    path: "/server-status",
    code: "exposed-server-status",
    title: "Server status page exposed",
    severity: "medium",
    detail: "An Apache server-status page is reachable; it leaks internal request activity.",
  },
  {
    path: "/phpinfo.php",
    code: "exposed-phpinfo",
    title: "phpinfo page exposed",
    severity: "medium",
    detail: "A phpinfo() page is reachable; it discloses detailed server configuration.",
  },
  {
    path: "/.DS_Store",
    code: "exposed-ds-store",
    title: ".DS_Store file exposed",
    severity: "low",
    detail: "A macOS .DS_Store file is reachable; it leaks directory and file names.",
  },
];

/**
 * Judges whether a sensitive path is exposed, from the HTTP status alone.
 *   2xx                -> exposed (the path's own severity)
 *   401 / 403          -> present but access-protected (info; confirm intent)
 *   anything else      -> no finding
 * The response body is never consulted, upholding "retain findings, not data".
 */
export function analyzeExposure(p: SensitivePath, status: number): Finding | null {
  if (status >= 200 && status < 300) {
    return { severity: p.severity, code: p.code, title: p.title, detail: p.detail };
  }
  if (status === 401 || status === 403) {
    return {
      severity: "info",
      code: `${p.code}-protected`,
      title: `${p.title} (present but protected)`,
      detail: `${p.path} exists but returned HTTP ${status}; confirm the protection is intentional.`,
    };
  }
  return null;
}
