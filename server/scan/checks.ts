import type { AuthAttemptResult, Finding, HttpResult, Severity, TlsResult } from "./types.js";

/**
 * Pure analysis functions. They take normalized probe results and return
 * findings. They never see or retain response bodies — only header/cert
 * metadata is inspected, and only the conclusion is kept.
 */

export function analyzeHeaders(http: HttpResult): Finding[] {
  const h = http.headers;
  const findings: Finding[] = [];

  const hsts = h["strict-transport-security"];
  if (!hsts) {
    findings.push({
      severity: "medium",
      code: "missing-hsts",
      title: "HSTS header missing",
      detail: "Strict-Transport-Security is not set; browsers may allow downgrade to HTTP.",
    });
  } else {
    const maxAgeMatch = /max-age\s*=\s*(\d+)/i.exec(hsts);
    const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
    if (maxAge < 15_552_000) {
      // < 180 days
      findings.push({
        severity: "low",
        code: "weak-hsts-max-age",
        title: "HSTS max-age is short",
        detail: "Strict-Transport-Security max-age is below 180 days; protection lapses sooner.",
      });
    }
    if (!/includesubdomains/i.test(hsts)) {
      findings.push({
        severity: "info",
        code: "hsts-no-subdomains",
        title: "HSTS without includeSubDomains",
        detail: "Strict-Transport-Security does not cover subdomains.",
      });
    }
  }

  const csp = h["content-security-policy"];
  if (!csp) {
    findings.push({
      severity: "medium",
      code: "missing-csp",
      title: "Content-Security-Policy missing",
      detail: "No CSP header; reduces defense against content injection and XSS.",
    });
  } else if (/'unsafe-inline'|'unsafe-eval'/i.test(csp)) {
    findings.push({
      severity: "low",
      code: "weak-csp",
      title: "Weak Content-Security-Policy",
      detail: "CSP allows 'unsafe-inline' or 'unsafe-eval', which weakens its XSS protection.",
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

  if (!h["cross-origin-opener-policy"]) {
    findings.push({
      severity: "info",
      code: "missing-coop",
      title: "Cross-Origin-Opener-Policy missing",
      detail: "COOP is not set; the page is less isolated from cross-origin windows.",
    });
  }

  // Overly permissive CORS. A literal '*' is low on its own; combined with
  // credentials it signals a dangerous misconfiguration.
  const acao = (h["access-control-allow-origin"] ?? "").trim();
  if (acao === "*") {
    const credentials = (h["access-control-allow-credentials"] ?? "").toLowerCase() === "true";
    if (credentials) {
      findings.push({
        severity: "medium",
        code: "cors-wildcard-credentials",
        title: "Wildcard CORS with credentials",
        detail:
          "Access-Control-Allow-Origin is '*' while credentials are allowed; a dangerous CORS misconfiguration.",
      });
    } else {
      findings.push({
        severity: "low",
        code: "cors-wildcard",
        title: "Wildcard CORS policy",
        detail: "Access-Control-Allow-Origin is '*'; any site can read responses from this origin.",
      });
    }
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
  let sameSiteNoneInsecure = 0;

  for (const cookie of setCookies) {
    // Drop the first segment (name=value) so we never inspect cookie data;
    // only the attribute tokens after it are examined.
    const attrTokens = cookie
      .split(";")
      .slice(1)
      .map((t) => t.trim().toLowerCase());
    const has = (name: string) => attrTokens.some((t) => t === name || t.startsWith(name + "="));
    const secure = has("secure");
    if (!secure) insecure++;
    if (!has("httponly")) noHttpOnly++;
    if (!has("samesite")) noSameSite++;
    if (attrTokens.some((t) => t === "samesite=none") && !secure) sameSiteNoneInsecure++;
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
  if (sameSiteNoneInsecure > 0) {
    findings.push({
      severity: "medium",
      code: "cookie-samesite-none-insecure",
      title: "SameSite=None cookie without Secure",
      detail: `${sameSiteNoneInsecure} cookie(s) use SameSite=None without the Secure attribute; browsers reject these and they can leak over HTTP.`,
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
  {
    path: "/.git/HEAD",
    code: "exposed-git-head",
    title: "Git HEAD exposed",
    severity: "high",
    detail: "A /.git/HEAD file is reachable; the repository may be fully downloadable.",
  },
  {
    path: "/.env.production",
    code: "exposed-env-production",
    title: "Production environment file exposed",
    severity: "high",
    detail: "A /.env.production file is reachable; it often holds production secrets.",
  },
  {
    path: "/.htpasswd",
    code: "exposed-htpasswd",
    title: ".htpasswd file exposed",
    severity: "high",
    detail: "A /.htpasswd file is reachable; it contains password hashes.",
  },
  {
    path: "/.aws/credentials",
    code: "exposed-aws-credentials",
    title: "AWS credentials file exposed",
    severity: "high",
    detail: "An /.aws/credentials file is reachable; it may contain cloud access keys.",
  },
  {
    path: "/.ssh/id_rsa",
    code: "exposed-ssh-key",
    title: "SSH private key exposed",
    severity: "high",
    detail: "An SSH private key path is reachable; it may grant server access.",
  },
  {
    path: "/.npmrc",
    code: "exposed-npmrc",
    title: ".npmrc file exposed",
    severity: "high",
    detail: "A /.npmrc file is reachable; it may contain registry auth tokens.",
  },
  {
    path: "/wp-config.php.bak",
    code: "exposed-wp-config-backup",
    title: "WordPress config backup exposed",
    severity: "high",
    detail: "A backup of wp-config.php is reachable; it may contain database credentials.",
  },
  {
    path: "/web.config",
    code: "exposed-web-config",
    title: "web.config exposed",
    severity: "medium",
    detail: "An IIS web.config file is reachable; it may reveal server configuration.",
  },
  {
    path: "/.htaccess",
    code: "exposed-htaccess",
    title: ".htaccess exposed",
    severity: "low",
    detail: "An /.htaccess file is reachable; it reveals rewrite and access rules.",
  },
  {
    path: "/docker-compose.yml",
    code: "exposed-docker-compose",
    title: "docker-compose.yml exposed",
    severity: "medium",
    detail: "A docker-compose.yml file is reachable; it reveals services and sometimes secrets.",
  },
  {
    path: "/server-info",
    code: "exposed-server-info",
    title: "Server info page exposed",
    severity: "medium",
    detail: "An Apache server-info page is reachable; it discloses server configuration.",
  },
  {
    path: "/phpmyadmin/",
    code: "exposed-phpmyadmin",
    title: "phpMyAdmin interface exposed",
    severity: "medium",
    detail: "A phpMyAdmin interface is reachable; database admin panels should not be public.",
  },
  {
    path: "/.idea/workspace.xml",
    code: "exposed-idea",
    title: "IDE project files exposed",
    severity: "low",
    detail: "JetBrains .idea project files are reachable; they leak project structure.",
  },
];

/**
 * Judges whether plain-HTTP is served without an immediate upgrade to HTTPS,
 * from an http:// probe result. A 2xx over HTTP means content is served in the
 * clear; a redirect that does not target https is also a problem. No body is
 * consulted.
 */
export function analyzeHttpRedirect(http: HttpResult): Finding | null {
  if (http.status >= 200 && http.status < 300) {
    return {
      severity: "medium",
      code: "no-https-redirect",
      title: "Plain HTTP served without redirect",
      detail: "The site answers over plain HTTP with content instead of redirecting to HTTPS.",
    };
  }
  if (http.status >= 300 && http.status < 400) {
    const location = (http.headers["location"] ?? "").toLowerCase();
    if (location && !location.startsWith("https://")) {
      return {
        severity: "low",
        code: "http-redirect-not-https",
        title: "HTTP redirect does not target HTTPS",
        detail: "Plain HTTP redirects somewhere other than an https:// URL.",
      };
    }
  }
  return null;
}

/**
 * Judges risky HTTP methods advertised by an OPTIONS response's Allow header.
 * TRACE enables cross-site tracing; write methods being advertised is worth a
 * look. Advertisement is a signal, not proof the methods are usable.
 */
export function analyzeHttpMethods(allowHeader: string | undefined): Finding[] {
  if (!allowHeader) return [];
  const methods = allowHeader
    .split(",")
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  const findings: Finding[] = [];

  if (methods.includes("TRACE")) {
    findings.push({
      severity: "medium",
      code: "http-trace-enabled",
      title: "HTTP TRACE method enabled",
      detail: "The server advertises the TRACE method, which can enable cross-site tracing (XST).",
    });
  }

  const writeMethods = methods.filter((m) => ["PUT", "DELETE", "PATCH"].includes(m));
  if (writeMethods.length > 0) {
    findings.push({
      severity: "info",
      code: "http-write-methods-advertised",
      title: "Write HTTP methods advertised",
      detail: `The server advertises ${writeMethods.join(", ")}; confirm these are intended to be public.`,
    });
  }

  return findings;
}

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

/**
 * Judges login hardening from a short series of deliberately-failed login
 * attempts (random, invalid credentials — never real accounts, never
 * enumeration). The conclusion is drawn from HTTP status / throttling signals
 * only; no credential or response data is ever retained.
 *
 *   - any attempt throttled (429/423/Retry-After) -> protection present (info)
 *   - fewer than 2 attempts                        -> no conclusion
 *   - every attempt identical, none throttled      -> no rate-limit (medium)
 *   - otherwise                                     -> inconclusive (info)
 */
export function analyzeAuthLockout(attempts: AuthAttemptResult[]): Finding[] {
  if (attempts.length < 2) return [];

  if (attempts.some((a) => a.rateLimited)) {
    return [
      {
        severity: "info",
        code: "login-rate-limit-present",
        title: "Login rate-limiting detected",
        detail: `The login endpoint throttled repeated failed attempts (observed within ${attempts.length} tries).`,
      },
    ];
  }

  const firstStatus = attempts[0]!.status;
  const allSameStatus = attempts.every((a) => a.status === firstStatus);
  if (allSameStatus) {
    return [
      {
        severity: "medium",
        code: "no-login-rate-limit",
        title: "No login rate-limiting or lockout",
        detail: `${attempts.length} rapid failed logins were all answered the same way with no throttling or lockout; the endpoint may allow unlimited password guessing.`,
      },
    ];
  }

  return [
    {
      severity: "info",
      code: "login-lockout-inconclusive",
      title: "Login hardening inconclusive",
      detail: "Responses to repeated failed logins varied without a clear throttling signal; review manually.",
    },
  ];
}
