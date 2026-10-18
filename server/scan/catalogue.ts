import type { DB } from "../db.js";
import { toHostname } from "../util/host.js";
import { AREAS } from "../health/report.js";
import { SENSITIVE_PATHS } from "./checks.js";
import type { Severity } from "./types.js";

/**
 * The full list of checks secval runs, with a plain-English fix for each.
 * Scans only store what FAILED (findings), so a check passes when it ran and
 * left no finding. This list is what turns "no finding" into a green pass.
 */
export type CheckGroup =
  | "headers"
  | "cookies"
  | "tls"
  | "paths"
  | "redirect"
  | "dns"
  | "methods"
  | "login"
  | "health";

export const GROUP_LABELS: Record<CheckGroup, string> = {
  headers: "Security headers",
  cookies: "Cookies",
  tls: "HTTPS certificate",
  paths: "Exposed files",
  redirect: "HTTP to HTTPS",
  dns: "Domain and email",
  methods: "Risky web methods",
  login: "Login protection",
  health: "App health report",
};

/** Header, cookie and TLS checks run in every scan; the rest only in an active scan. */
const ACTIVE_ONLY: CheckGroup[] = ["paths", "redirect", "dns", "methods", "login"];

export interface CatalogueCheck {
  code: string;
  group: CheckGroup;
  title: string;
  severity: Severity;
  /** What to do when the check fails. */
  fix: string;
  /** Finding codes that mean this check failed (defaults to [code]). */
  failCodes?: string[];
}

const c = (group: CheckGroup, code: string, severity: Severity, title: string, fix: string): CatalogueCheck => ({
  code,
  group,
  severity,
  title,
  fix,
});

const BASE: CatalogueCheck[] = [
  // --- Security headers (40) ---
  c("headers", "missing-hsts", "medium", "HTTPS is enforced (HSTS)", "Add the header Strict-Transport-Security: max-age=31536000; includeSubDomains."),
  c("headers", "weak-hsts-max-age", "low", "HSTS lasts long enough", "Raise the HSTS max-age to at least 15552000 (180 days); one year is common."),
  c("headers", "hsts-no-subdomains", "info", "HSTS covers subdomains", "Add includeSubDomains to the Strict-Transport-Security header."),
  c("headers", "missing-csp", "medium", "Content-Security-Policy is set", "Add a Content-Security-Policy header, starting with default-src 'self'."),
  c("headers", "weak-csp", "low", "CSP blocks unsafe scripts", "Remove 'unsafe-inline' and 'unsafe-eval' from the script rules of your CSP."),
  c("headers", "missing-xcto", "low", "Browsers can't guess file types", "Add the header X-Content-Type-Options: nosniff."),
  c("headers", "missing-framing-protection", "low", "Protected from clickjacking", "Add X-Frame-Options: DENY, or frame-ancestors 'none' in your CSP."),
  c("headers", "missing-referrer-policy", "low", "Referrer-Policy is set", "Add the header Referrer-Policy: strict-origin-when-cross-origin."),
  c("headers", "missing-permissions-policy", "info", "Permissions-Policy is set", "Add a Permissions-Policy header that turns off camera, microphone and location if unused."),
  c("headers", "csp-default-src-missing", "low", "CSP has a default rule", "Add default-src 'self' to your CSP so anything not listed is blocked."),
  c("headers", "csp-object-src-missing", "info", "CSP blocks plugins", "Add object-src 'none' to your CSP."),
  c("headers", "csp-base-uri-missing", "info", "CSP locks the base address", "Add base-uri 'self' to your CSP."),
  c("headers", "csp-report-only-only", "low", "CSP is enforced, not just reported", "Switch Content-Security-Policy-Report-Only to Content-Security-Policy once it causes no breakage."),
  c("headers", "xfo-invalid-value", "low", "X-Frame-Options has a safe value", "Set X-Frame-Options to DENY or SAMEORIGIN."),
  c("headers", "referrer-policy-unsafe", "low", "Referrer-Policy doesn't leak full URLs", "Change Referrer-Policy to strict-origin-when-cross-origin."),
  c("headers", "x-xss-protection-enabled", "info", "Old XSS filter is off", "Set X-XSS-Protection: 0 (or remove it) and rely on CSP instead."),
  c("headers", "missing-coop", "info", "Cross-Origin-Opener-Policy is set", "Add the header Cross-Origin-Opener-Policy: same-origin."),
  c("headers", "missing-coep", "info", "Cross-Origin-Embedder-Policy is set", "Add Cross-Origin-Embedder-Policy: require-corp if your page loads no outside resources."),
  c("headers", "missing-corp", "info", "Cross-Origin-Resource-Policy is set", "Add the header Cross-Origin-Resource-Policy: same-origin."),
  c("headers", "missing-xpcdp", "info", "Cross-domain policy files blocked", "Add the header X-Permitted-Cross-Domain-Policies: none."),
  c("headers", "missing-cache-control", "info", "Caching rules are set", "Add a Cache-Control header, e.g. no-store for private pages."),
  c("headers", "content-type-missing", "info", "Content-Type is sent", "Make the server send a Content-Type header on every page."),
  c("headers", "content-type-no-charset", "info", "Text encoding is declared", "Send Content-Type: text/html; charset=utf-8."),
  c("headers", "x-dns-prefetch-on", "info", "DNS prefetching isn't forced on", "Remove X-DNS-Prefetch-Control: on, or set it to off."),
  c("headers", "legacy-csp-header", "info", "No old X-Content-Security-Policy", "Remove X-Content-Security-Policy; keep only Content-Security-Policy."),
  c("headers", "legacy-webkit-csp-header", "info", "No old X-WebKit-CSP", "Remove X-WebKit-CSP; keep only Content-Security-Policy."),
  c("headers", "legacy-feature-policy", "info", "No old Feature-Policy", "Replace Feature-Policy with Permissions-Policy."),
  c("headers", "cors-wildcard-credentials", "medium", "CORS doesn't share logins with any site", "Never combine Access-Control-Allow-Origin: * with credentials; list your own sites instead."),
  c("headers", "cors-wildcard", "low", "CORS doesn't allow every site", "Replace Access-Control-Allow-Origin: * with the exact sites that need access."),
  c("headers", "cors-null-origin", "medium", "CORS doesn't allow 'null'", "Stop allowing the origin 'null' in Access-Control-Allow-Origin."),
  c("headers", "cors-methods-wildcard", "low", "CORS lists only needed methods", "Replace Access-Control-Allow-Methods: * with the methods you use, e.g. GET, POST."),
  c("headers", "cors-expose-headers-wildcard", "info", "CORS exposes only needed headers", "Replace Access-Control-Expose-Headers: * with the headers you need."),
  c("headers", "version-disclosure", "info", "Server version is hidden", "Configure the server so the Server header doesn't show a version number."),
  c("headers", "x-powered-by-present", "info", "Backend tech is hidden", "Remove the X-Powered-By header (in Express: app.disable('x-powered-by'))."),
  c("headers", "x-aspnet-version-present", "info", "ASP.NET version is hidden", "Turn off the X-AspNet-Version header in web.config."),
  c("headers", "x-aspnetmvc-version-present", "info", "ASP.NET MVC version is hidden", "Turn off the X-AspNetMvc-Version header at app start."),
  c("headers", "x-runtime-present", "info", "Response timing is hidden", "Remove the X-Runtime header."),
  c("headers", "via-header-present", "info", "Proxy software is hidden", "Remove or blank the Via header at your proxy."),
  c("headers", "x-generator-present", "info", "Website builder is hidden", "Remove the X-Generator header in your CMS settings."),
  c("headers", "server-timing-present", "info", "Internal timings are hidden", "Remove the Server-Timing header in production."),

  // --- Cookies (6) ---
  c("cookies", "cookie-not-secure", "medium", "Cookies only travel over HTTPS", "Add the Secure flag to every cookie."),
  c("cookies", "cookie-not-httponly", "low", "Cookies hidden from page scripts", "Add the HttpOnly flag to cookies that scripts don't need."),
  c("cookies", "cookie-no-samesite", "low", "Cookies have a SameSite rule", "Add SameSite=Lax (or Strict) to every cookie."),
  c("cookies", "cookie-samesite-none-insecure", "medium", "SameSite=None cookies are Secure", "Any cookie with SameSite=None must also have Secure."),
  c("cookies", "cookie-domain-too-broad", "low", "Cookies not shared with all subdomains", "Remove the leading-dot Domain attribute so cookies stay on this site."),
  c("cookies", "cookie-long-lived", "info", "Cookies don't live too long", "Shorten cookie lifetime to under a year."),

  // --- TLS / certificate (6) ---
  c("tls", "tls-handshake-failed", "high", "HTTPS connection works", "Make sure the site serves HTTPS with a valid certificate on port 443."),
  c("tls", "tls-outdated", "high", "No old TLS versions", "Turn off TLS 1.0 and 1.1 at your host; allow only 1.2 and 1.3."),
  c("tls", "tls-below-1.3", "info", "Uses TLS 1.3", "Enable TLS 1.3 at your host or proxy."),
  c("tls", "tls-cert-invalid", "high", "Certificate is trusted", "Install a certificate from a trusted provider (Let's Encrypt is free)."),
  c("tls", "tls-cert-expired", "high", "Certificate is not expired", "Renew the certificate now and turn on auto-renewal."),
  c("tls", "tls-cert-expiring", "medium", "Certificate isn't about to expire", "Renew the certificate soon and turn on auto-renewal."),

  // --- HTTP to HTTPS (2) ---
  c("redirect", "no-https-redirect", "medium", "Plain HTTP sends you to HTTPS", "Make http:// addresses redirect (301) to https://."),
  c("redirect", "http-redirect-not-https", "low", "HTTP redirect goes to HTTPS", "Point the http:// redirect at the https:// address."),

  // --- Domain and email (5) ---
  c("dns", "spf-missing", "info", "SPF record exists", "Add a DNS TXT record like v=spf1 -all (or list your mail provider)."),
  c("dns", "spf-weak", "low", "SPF is strict", "End your SPF record with -all or ~all, not +all or ?all."),
  c("dns", "dmarc-missing", "low", "DMARC record exists", "Add a TXT record at _dmarc with v=DMARC1; p=quarantine."),
  c("dns", "dmarc-policy-none", "info", "DMARC blocks fake mail", "Change your DMARC policy from p=none to p=quarantine or p=reject."),
  c("dns", "caa-missing", "info", "CAA record limits who can issue certificates", "Add a DNS CAA record naming your certificate provider, e.g. letsencrypt.org."),

  // --- Risky web methods (3) ---
  c("methods", "http-trace-enabled", "medium", "TRACE method is off", "Turn off the TRACE method on your server."),
  c("methods", "http-connect-enabled", "medium", "CONNECT method is off", "Turn off the CONNECT method on your server."),
  c("methods", "http-write-methods-advertised", "info", "Write methods aren't advertised", "Only allow PUT, DELETE and PATCH on routes that need them."),

  // --- Login protection (1 check, 3 possible outcomes) ---
  {
    group: "login",
    code: "login-rate-limit",
    severity: "medium",
    title: "Login blocks repeated wrong passwords",
    fix: "Limit failed logins (e.g. 5 per minute per user and IP) and slow down or lock after that.",
    failCodes: ["no-login-rate-limit", "login-lockout-inconclusive"],
  },
];

const PATH_CHECKS: CatalogueCheck[] = SENSITIVE_PATHS.map((p) => ({
  group: "paths",
  code: p.code,
  severity: p.severity,
  title: `${p.path} is not public`,
  fix:
    `Remove ${p.path} from the public site, or block it in your server settings.` +
    (p.severity === "high" ? " If it held passwords or keys, change them." : ""),
  failCodes: [p.code, `${p.code}-protected`],
}));

export const CATALOGUE: CatalogueCheck[] = [...BASE, ...PATH_CHECKS];

export type CheckStatus = "pass" | "fail" | "not-run";

export interface CheckRow {
  code: string;
  group: CheckGroup;
  groupLabel: string;
  title: string;
  severity: Severity;
  status: CheckStatus;
  /** For a fail: what to do. For not-run: why it didn't run. */
  advice: string | null;
  /** The finding's own explanation, when it failed. */
  detail: string | null;
}

export interface CheckReport {
  host: string;
  /** Date of the newest health report score used, if any. */
  reportDate: string | null;
  lastScan: { id: string; mode: string; finishedAt: string } | null;
  lastActiveScan: { id: string; finishedAt: string } | null;
  total: number;
  passed: number;
  failed: number;
  notRun: number;
  checks: CheckRow[];
}

type ScanRow = { id: string; mode: string; finished_at: string };

function latestScan(db: DB, host: string, mode?: "active"): ScanRow | null {
  const sql =
    `SELECT id, mode, finished_at FROM scans WHERE target = ? AND status = 'completed'` +
    (mode ? ` AND mode = 'active'` : "") +
    ` ORDER BY finished_at DESC LIMIT 1`;
  return (db.prepare(sql).get(host) as ScanRow | undefined) ?? null;
}

function findingsOf(db: DB, scanId: string): Map<string, string> {
  const rows = db.prepare(`SELECT code, detail FROM findings WHERE scan_id = ?`).all(scanId) as Array<{
    code: string;
    detail: string;
  }>;
  return new Map(rows.map((r) => [r.code, r.detail]));
}

/**
 * Builds the pass/fail list for one app from its latest completed scans.
 * Header, cookie and TLS checks come from the newest scan of any kind; the
 * other checks come from the newest active scan, and show "not run" until
 * one exists. Read-only: it only looks at stored findings.
 */
export function checkReport(db: DB, target: string): CheckReport {
  const host = toHostname(target) ?? target;
  const any = latestScan(db, host);
  const active = latestScan(db, host, "active");
  const anyFindings = any ? findingsOf(db, any.id) : new Map<string, string>();
  const activeFindings = active ? findingsOf(db, active.id) : new Map<string, string>();

  const pathsSkipped = activeFindings.has("exposed-check-inconclusive");
  const loginTested = ["login-rate-limit-present", "no-login-rate-limit", "login-lockout-inconclusive"].some((k) =>
    activeFindings.has(k),
  );

  const checks: CheckRow[] = CATALOGUE.map((chk) => {
    const activeOnly = ACTIVE_ONLY.includes(chk.group);
    const base = {
      code: chk.code,
      group: chk.group,
      groupLabel: GROUP_LABELS[chk.group],
      title: chk.title,
      severity: chk.severity,
    };
    const notRun = (why: string): CheckRow => ({ ...base, status: "not-run", advice: why, detail: null });

    if (!any) return notRun("No scan yet. Press Scan on this app.");
    if (activeOnly && !active) return notRun("Runs only in an active scan, which this app hasn't had yet.");
    if (chk.group === "paths" && pathsSkipped)
      return notRun("Skipped: the site answers every address with a page, so file checks can't tell.");
    if (chk.group === "login" && !loginTested) return notRun("Runs only when an active scan is given the login page.");

    const found = activeOnly ? activeFindings : anyFindings;
    const hit = (chk.failCodes ?? [chk.code]).find((code) => found.has(code));
    if (!hit) return { ...base, status: "pass", advice: null, detail: null };
    const advice = hit.endsWith("-protected")
      ? "It exists but is blocked. Better to delete it from the server entirely."
      : chk.fix;
    return { ...base, status: "fail", advice, detail: found.get(hit) ?? null };
  });

  checks.push(...healthRows(db, host));

  return {
    host,
    reportDate: latestReportDate(db, host),
    lastScan: any ? { id: any.id, mode: any.mode, finishedAt: any.finished_at } : null,
    lastActiveScan: active ? { id: active.id, finishedAt: active.finished_at } : null,
    total: checks.length,
    passed: checks.filter((r) => r.status === "pass").length,
    failed: checks.filter((r) => r.status === "fail").length,
    notRun: checks.filter((r) => r.status === "not-run").length,
    checks,
  };
}

/** Score at or above this counts as a pass (the dashboard's green). */
export const HEALTH_PASS_SCORE = 85;

/** What to work on when a criterion scores below green. */
export const AREA_ADVICE: Record<(typeof AREAS)[number]["key"], string> = {
  security: "Fix the failed security checks above, require login on every private page, and limit wrong-password tries.",
  privacy: "Keep secrets out of the code, encrypt backups with separate keys, and store only the personal data you need.",
  integrity: "Add database rules (unique, not-null, foreign keys) and tests that check the data stays consistent.",
  persistence: "Back up the database daily, test a restore regularly, and make sure files users upload are backed up too.",
  functional: "List the app's main tasks and check each one works end to end, with a test where possible.",
  ux: "Check the main pages on a phone and a computer; make errors clear and buttons easy to find.",
  performance: "Measure page load times, speed up the slowest pages and queries, and avoid the free tier going to sleep.",
  reliability: "Fix failing test runs, catch errors so one bad request can't crash the app, and alert on downtime.",
  code: "Split very large files into smaller ones, fix all type errors, and add tests for the main features.",
  deploy: "Deploy automatically after tests pass, keep a one-click rollback, and write down the host settings.",
};

function latestReportDate(db: DB, host: string): string | null {
  const row = db.prepare(`SELECT MAX(created_at) AS d FROM health_scores WHERE host = ?`).get(host) as
    | { d: string | null }
    | undefined;
  return row?.d ?? null;
}

/**
 * One row per health criterion, from the newest score saved for it (reports/
 * files loaded at start, or pasted reports). These are estimates from a
 * report, not something secval measured. The report's own reasons are shown.
 */
function healthRows(db: DB, host: string): CheckRow[] {
  const rows = db
    .prepare(
      `SELECT area, score, evidence FROM health_scores WHERE host = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(host) as Array<{ area: string; score: number; evidence: string }>;
  return AREAS.map((a) => {
    const base = {
      code: `health-${a.key}`,
      group: "health" as const,
      groupLabel: GROUP_LABELS.health,
      title: a.label,
      severity: "info" as Severity,
    };
    const r = rows.find((x) => x.area === a.key);
    if (!r) return { ...base, status: "not-run" as const, advice: "Not rated in any health report yet.", detail: null };
    const pass = r.score >= HEALTH_PASS_SCORE;
    return {
      ...base,
      title: `${a.label}: ${r.score}/100`,
      status: pass ? ("pass" as const) : ("fail" as const),
      advice: pass ? null : AREA_ADVICE[a.key],
      detail: r.evidence || null,
    };
  });
}
