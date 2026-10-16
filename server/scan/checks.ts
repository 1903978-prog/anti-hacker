import type { AuthAttemptResult, DnsRecords, Finding, HttpResult, Severity, TlsResult } from "./types.js";

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
  } else {
    // 'unsafe-eval' anywhere is weak; 'unsafe-inline' only matters where scripts
    // execute (script-src, or default-src when script-src is absent). Inline
    // styles are far lower risk and do not trip this check.
    const cspLower = csp.toLowerCase();
    const scriptDirective =
      /script-src([^;]*)/.exec(cspLower)?.[1] ?? /default-src([^;]*)/.exec(cspLower)?.[1] ?? "";
    if (/'unsafe-eval'/.test(cspLower) || /'unsafe-inline'/.test(scriptDirective)) {
      findings.push({
        severity: "low",
        code: "weak-csp",
        title: "Weak Content-Security-Policy",
        detail: "CSP allows 'unsafe-inline' scripts or 'unsafe-eval', which weakens its XSS protection.",
      });
    }
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

  // Deeper CSP directive hygiene (only when a CSP is present).
  if (csp) {
    const cspLower = csp.toLowerCase();
    if (!/default-src/.test(cspLower)) {
      findings.push({
        severity: "low",
        code: "csp-default-src-missing",
        title: "CSP has no default-src",
        detail: "Content-Security-Policy omits default-src, leaving unlisted resource types unrestricted.",
      });
    }
    if (!/object-src/.test(cspLower)) {
      findings.push({
        severity: "info",
        code: "csp-object-src-missing",
        title: "CSP has no object-src",
        detail: "Content-Security-Policy omits object-src; plugin content is not explicitly blocked.",
      });
    }
    if (!/base-uri/.test(cspLower)) {
      findings.push({
        severity: "info",
        code: "csp-base-uri-missing",
        title: "CSP has no base-uri",
        detail: "Content-Security-Policy omits base-uri; base-tag injection is not restricted.",
      });
    }
  }
  if (h["content-security-policy-report-only"] && !csp) {
    findings.push({
      severity: "low",
      code: "csp-report-only-only",
      title: "CSP is report-only",
      detail: "Only a report-only CSP is set; it monitors but does not enforce protection.",
    });
  }

  // X-Frame-Options present but not a recognised safe value.
  const xfo = (h["x-frame-options"] ?? "").trim().toUpperCase();
  if (xfo && xfo !== "DENY" && xfo !== "SAMEORIGIN") {
    findings.push({
      severity: "low",
      code: "xfo-invalid-value",
      title: "X-Frame-Options has a weak value",
      detail: `X-Frame-Options is '${xfo}', not DENY or SAMEORIGIN; clickjacking protection may not apply.`,
    });
  }

  // Referrer-Policy present but set to a leaky value.
  const refPol = (h["referrer-policy"] ?? "").toLowerCase();
  if (refPol && /unsafe-url|no-referrer-when-downgrade/.test(refPol)) {
    findings.push({
      severity: "low",
      code: "referrer-policy-unsafe",
      title: "Weak Referrer-Policy",
      detail: "Referrer-Policy allows the full URL to leak to other origins.",
    });
  }

  // Deprecated X-XSS-Protection enabled (its filter can introduce issues; modern
  // guidance is to disable it and rely on CSP).
  if (/^1/.test((h["x-xss-protection"] ?? "").trim())) {
    findings.push({
      severity: "info",
      code: "x-xss-protection-enabled",
      title: "Deprecated X-XSS-Protection enabled",
      detail: "X-XSS-Protection is enabled; it is deprecated and can introduce vulnerabilities. Prefer CSP.",
    });
  }

  // Missing isolation / misc hardening headers (informational).
  const missingInfoHeaders: Array<[string, string, string]> = [
    ["cross-origin-opener-policy", "missing-coop", "Cross-Origin-Opener-Policy is not set; the page is less isolated from cross-origin windows."],
    ["cross-origin-embedder-policy", "missing-coep", "Cross-Origin-Embedder-Policy is not set; cross-origin isolation is incomplete."],
    ["cross-origin-resource-policy", "missing-corp", "Cross-Origin-Resource-Policy is not set; resources are not restricted from cross-origin embedding."],
    ["x-permitted-cross-domain-policies", "missing-xpcdp", "X-Permitted-Cross-Domain-Policies is not set; Adobe clients may load cross-domain policies."],
    ["cache-control", "missing-cache-control", "Cache-Control is not set; responses may be cached in unintended ways."],
  ];
  for (const [header, code, detail] of missingInfoHeaders) {
    if (!h[header]) {
      findings.push({ severity: "info", code, title: `${header} header missing`, detail });
    }
  }

  // Content-Type hygiene.
  const contentType = h["content-type"];
  if (!contentType) {
    findings.push({
      severity: "info",
      code: "content-type-missing",
      title: "Content-Type missing",
      detail: "No Content-Type header; browsers may guess the type (MIME sniffing).",
    });
  } else if (/text\/html/i.test(contentType) && !/charset/i.test(contentType)) {
    findings.push({
      severity: "info",
      code: "content-type-no-charset",
      title: "Content-Type has no charset",
      detail: "An HTML Content-Type without a charset can enable some injection techniques.",
    });
  }

  // X-DNS-Prefetch-Control explicitly on (minor privacy leak).
  if ((h["x-dns-prefetch-control"] ?? "").toLowerCase() === "on") {
    findings.push({
      severity: "info",
      code: "x-dns-prefetch-on",
      title: "DNS prefetching enabled",
      detail: "X-DNS-Prefetch-Control is 'on'; the browser may prefetch DNS for linked domains.",
    });
  }

  // Legacy/deprecated security headers present.
  const legacyHeaders: Array<[string, string, string]> = [
    ["x-content-security-policy", "legacy-csp-header", "A legacy X-Content-Security-Policy header is set; use Content-Security-Policy instead."],
    ["x-webkit-csp", "legacy-webkit-csp-header", "A legacy X-WebKit-CSP header is set; use Content-Security-Policy instead."],
    ["feature-policy", "legacy-feature-policy", "The deprecated Feature-Policy header is set; use Permissions-Policy instead."],
  ];
  for (const [header, code, detail] of legacyHeaders) {
    if (h[header]) {
      findings.push({ severity: "info", code, title: `Deprecated '${header}' header`, detail });
    }
  }

  // Overly permissive CORS.
  const acao = (h["access-control-allow-origin"] ?? "").trim();
  const credentials = (h["access-control-allow-credentials"] ?? "").toLowerCase() === "true";
  if (acao === "*") {
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
  } else if (acao.toLowerCase() === "null") {
    findings.push({
      severity: "medium",
      code: "cors-null-origin",
      title: "CORS allows the 'null' origin",
      detail: "Access-Control-Allow-Origin is 'null', which several sandboxed contexts can forge.",
    });
  }
  if ((h["access-control-allow-methods"] ?? "").trim() === "*") {
    findings.push({
      severity: "low",
      code: "cors-methods-wildcard",
      title: "Wildcard CORS methods",
      detail: "Access-Control-Allow-Methods is '*'; all HTTP methods are permitted cross-origin.",
    });
  }
  if ((h["access-control-expose-headers"] ?? "").trim() === "*") {
    findings.push({
      severity: "info",
      code: "cors-expose-headers-wildcard",
      title: "Wildcard CORS exposed headers",
      detail: "Access-Control-Expose-Headers is '*'; all response headers are exposed cross-origin.",
    });
  }

  // Software/version disclosure via headers.
  if ((h["server"] ?? "") && /\d/.test(h["server"] ?? "")) {
    findings.push({
      severity: "info",
      code: "version-disclosure",
      title: "Software version disclosed via 'server'",
      detail: "The 'server' response header reveals software/version details.",
    });
  }
  const disclosureHeaders: Array<[string, string, string]> = [
    ["x-powered-by", "x-powered-by-present", "The 'x-powered-by' header reveals the backend technology."],
    ["x-aspnet-version", "x-aspnet-version-present", "The 'x-aspnet-version' header reveals the ASP.NET version."],
    ["x-aspnetmvc-version", "x-aspnetmvc-version-present", "The 'x-aspnetmvc-version' header reveals the ASP.NET MVC version."],
    ["x-runtime", "x-runtime-present", "The 'x-runtime' header reveals response timing, aiding timing attacks."],
    ["via", "via-header-present", "The 'via' header reveals proxy/intermediary software."],
    ["x-generator", "x-generator-present", "The 'x-generator' header reveals the CMS/generator used."],
    ["server-timing", "server-timing-present", "The 'server-timing' header can disclose internal timing details."],
  ];
  for (const [header, code, detail] of disclosureHeaders) {
    if (h[header]) {
      findings.push({ severity: "info", code, title: `Information disclosed via '${header}'`, detail });
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
  let broadDomain = 0;
  let longLived = 0;

  for (const cookie of setCookies) {
    // Drop the first segment (name=value) so we never inspect cookie data;
    // only the attribute tokens after it are examined.
    const attrTokens = cookie
      .split(";")
      .slice(1)
      .map((t) => t.trim().toLowerCase());
    const has = (name: string) => attrTokens.some((t) => t === name || t.startsWith(name + "="));
    const attr = (name: string) =>
      attrTokens.find((t) => t.startsWith(name + "="))?.slice(name.length + 1);
    const secure = has("secure");
    if (!secure) insecure++;
    if (!has("httponly")) noHttpOnly++;
    if (!has("samesite")) noSameSite++;
    if (attrTokens.some((t) => t === "samesite=none") && !secure) sameSiteNoneInsecure++;

    // Domain attribute with a leading dot scopes the cookie to all subdomains.
    const domain = attr("domain");
    if (domain && domain.startsWith(".")) broadDomain++;

    // Very long lifetime (> ~400 days) keeps session material around needlessly.
    const maxAge = Number(attr("max-age"));
    if (Number.isFinite(maxAge) && maxAge > 34_560_000) longLived++;
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
  if (broadDomain > 0) {
    findings.push({
      severity: "low",
      code: "cookie-domain-too-broad",
      title: "Cookie scoped to all subdomains",
      detail: `${broadDomain} cookie(s) use a leading-dot Domain attribute, sharing them with every subdomain.`,
    });
  }
  if (longLived > 0) {
    findings.push({
      severity: "info",
      code: "cookie-long-lived",
      title: "Cookie with a very long lifetime",
      detail: `${longLived} cookie(s) have a Max-Age over ~400 days; long-lived session material increases exposure.`,
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
  } else if (version !== null && version < 1.3) {
    findings.push({
      severity: "info",
      code: "tls-below-1.3",
      title: `TLS ${tls.protocol} in use`,
      detail: "The server negotiated TLS below 1.3; consider enabling TLS 1.3.",
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
  {
    path: "/.env.local",
    code: "exposed-env-local",
    title: "Local environment file exposed",
    severity: "high",
    detail: "A /.env.local file is reachable; it often holds developer secrets.",
  },
  {
    path: "/.env.development",
    code: "exposed-env-development",
    title: "Development environment file exposed",
    severity: "high",
    detail: "A /.env.development file is reachable; it may hold credentials.",
  },
  {
    path: "/.git/logs/HEAD",
    code: "exposed-git-logs",
    title: "Git logs exposed",
    severity: "high",
    detail: "A /.git/logs/HEAD file is reachable; commit history may be downloadable.",
  },
  {
    path: "/.vscode/settings.json",
    code: "exposed-vscode",
    title: "VS Code settings exposed",
    severity: "low",
    detail: "VS Code project settings are reachable; they can leak project details.",
  },
  {
    path: "/appsettings.json",
    code: "exposed-appsettings",
    title: ".NET appsettings.json exposed",
    severity: "high",
    detail: "An appsettings.json file is reachable; it commonly holds connection strings and secrets.",
  },
  {
    path: "/config.json",
    code: "exposed-config-json",
    title: "config.json exposed",
    severity: "medium",
    detail: "A config.json file is reachable; it may reveal configuration or secrets.",
  },
  {
    path: "/secrets.json",
    code: "exposed-secrets-json",
    title: "secrets.json exposed",
    severity: "high",
    detail: "A secrets.json file is reachable; it likely contains sensitive credentials.",
  },
  {
    path: "/credentials.json",
    code: "exposed-credentials-json",
    title: "credentials.json exposed",
    severity: "high",
    detail: "A credentials.json file is reachable; it likely contains access credentials.",
  },
  {
    path: "/db.sqlite",
    code: "exposed-sqlite",
    title: "SQLite database exposed",
    severity: "high",
    detail: "A db.sqlite file is reachable; a full database may be downloadable.",
  },
  {
    path: "/database.sqlite",
    code: "exposed-sqlite-alt",
    title: "SQLite database exposed",
    severity: "high",
    detail: "A database.sqlite file is reachable; a full database may be downloadable.",
  },
  {
    path: "/dump.sql",
    code: "exposed-dump-sql",
    title: "SQL dump exposed",
    severity: "high",
    detail: "A dump.sql file is reachable; it may contain a full database export.",
  },
  {
    path: "/backup.zip",
    code: "exposed-backup-zip",
    title: "Backup archive exposed",
    severity: "high",
    detail: "A backup.zip file is reachable; it may contain source or data.",
  },
  {
    path: "/backup.tar.gz",
    code: "exposed-backup-targz",
    title: "Backup archive exposed",
    severity: "high",
    detail: "A backup.tar.gz file is reachable; it may contain source or data.",
  },
  {
    path: "/.bash_history",
    code: "exposed-bash-history",
    title: "Shell history exposed",
    severity: "high",
    detail: "A /.bash_history file is reachable; it can reveal commands and secrets typed on the server.",
  },
  {
    path: "/composer.json",
    code: "exposed-composer-json",
    title: "composer.json exposed",
    severity: "low",
    detail: "A composer.json file is reachable; it reveals PHP dependencies.",
  },
  {
    path: "/composer.lock",
    code: "exposed-composer-lock",
    title: "composer.lock exposed",
    severity: "low",
    detail: "A composer.lock file is reachable; it reveals exact dependency versions.",
  },
  {
    path: "/package.json",
    code: "exposed-package-json",
    title: "package.json exposed",
    severity: "low",
    detail: "A package.json file is reachable; it reveals Node dependencies and scripts.",
  },
  {
    path: "/yarn.lock",
    code: "exposed-yarn-lock",
    title: "yarn.lock exposed",
    severity: "low",
    detail: "A yarn.lock file is reachable; it reveals exact dependency versions.",
  },
  {
    path: "/Gemfile.lock",
    code: "exposed-gemfile-lock",
    title: "Gemfile.lock exposed",
    severity: "low",
    detail: "A Gemfile.lock file is reachable; it reveals exact Ruby dependency versions.",
  },
  {
    path: "/Dockerfile",
    code: "exposed-dockerfile",
    title: "Dockerfile exposed",
    severity: "low",
    detail: "A Dockerfile is reachable; it reveals build steps and sometimes secrets.",
  },
  {
    path: "/.gitlab-ci.yml",
    code: "exposed-gitlab-ci",
    title: "GitLab CI config exposed",
    severity: "low",
    detail: "A /.gitlab-ci.yml file is reachable; it reveals pipeline configuration.",
  },
  {
    path: "/.travis.yml",
    code: "exposed-travis",
    title: "Travis CI config exposed",
    severity: "low",
    detail: "A /.travis.yml file is reachable; it reveals pipeline configuration.",
  },
  {
    path: "/swagger.json",
    code: "exposed-swagger",
    title: "API specification exposed",
    severity: "medium",
    detail: "A swagger.json file is reachable; it maps out the API surface for an attacker.",
  },
  {
    path: "/openapi.json",
    code: "exposed-openapi",
    title: "OpenAPI specification exposed",
    severity: "medium",
    detail: "An openapi.json file is reachable; it maps out the API surface for an attacker.",
  },
  {
    path: "/error_log",
    code: "exposed-error-log",
    title: "Error log exposed",
    severity: "medium",
    detail: "An error_log file is reachable; logs can leak paths, queries, and secrets.",
  },
  {
    path: "/debug.log",
    code: "exposed-debug-log",
    title: "Debug log exposed",
    severity: "medium",
    detail: "A debug.log file is reachable; logs can leak paths, queries, and secrets.",
  },
  {
    path: "/npm-debug.log",
    code: "exposed-npm-debug-log",
    title: "npm debug log exposed",
    severity: "low",
    detail: "An npm-debug.log file is reachable; it can leak environment details.",
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
/**
 * Judges email/domain security posture from read-only DNS records. These are
 * informational for a web host but flag real gaps for anything that sends mail.
 */
export function analyzeDns(dns: DnsRecords): Finding[] {
  const findings: Finding[] = [];

  const spf = dns.txt.find((t) => /^v=spf1/i.test(t.trim()));
  if (!spf) {
    findings.push({
      severity: "info",
      code: "spf-missing",
      title: "No SPF record",
      detail: "No v=spf1 TXT record was found; mail from this domain is easier to spoof.",
    });
  } else if (/[?+]all\b/i.test(spf)) {
    findings.push({
      severity: "low",
      code: "spf-weak",
      title: "Weak SPF policy",
      detail: "The SPF record ends in +all or ?all, which does not restrict senders.",
    });
  }

  const dmarc = dns.dmarcTxt.find((t) => /^v=dmarc1/i.test(t.trim()));
  if (!dmarc) {
    findings.push({
      severity: "low",
      code: "dmarc-missing",
      title: "No DMARC record",
      detail: "No DMARC policy was found at _dmarc; spoofed mail is not reported or rejected.",
    });
  } else if (/p=none/i.test(dmarc)) {
    findings.push({
      severity: "info",
      code: "dmarc-policy-none",
      title: "DMARC policy is 'none'",
      detail: "The DMARC policy is p=none; it monitors but does not block spoofed mail.",
    });
  }

  if (dns.caa.length === 0) {
    findings.push({
      severity: "info",
      code: "caa-missing",
      title: "No CAA record",
      detail: "No CAA record restricts which certificate authorities may issue for this domain.",
    });
  }

  return findings;
}

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

  if (methods.includes("CONNECT")) {
    findings.push({
      severity: "medium",
      code: "http-connect-enabled",
      title: "HTTP CONNECT method enabled",
      detail: "The server advertises the CONNECT method, which can allow it to be used as a proxy.",
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
