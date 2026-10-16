export type Severity = "high" | "medium" | "low" | "info";

/**
 * A single finding. By design it records only the *fact* that a weakness
 * exists — never the data read from the target. `detail` is a short,
 * self-contained explanation safe to retain.
 */
export interface Finding {
  severity: Severity;
  code: string;
  title: string;
  detail: string;
}

/** Normalized result of a single passive HTTP(S) GET. No body is retained. */
export interface HttpResult {
  status: number;
  /** Header names lowercased; multiple values joined with ", ". */
  headers: Record<string, string>;
  /** Raw Set-Cookie values (attributes only are inspected, never contents). */
  setCookies: string[];
}

/** Normalized result of a TLS handshake probe. */
export interface TlsResult {
  /** e.g. "TLSv1.3", or null if the handshake failed. */
  protocol: string | null;
  /** Certificate notAfter as an ISO string, or null. */
  validTo: string | null;
  /** Whether the peer certificate chain is authorized/valid. */
  authorized: boolean;
  authorizationError?: string | null;
}

/**
 * Result of a single login-hardening probe: one POST of deliberately-invalid,
 * random credentials. Only the status and whether the server throttled is
 * kept — never any response body.
 */
export interface AuthAttemptResult {
  status: number;
  /** True if the server signalled rate-limiting/lockout (429/423 or Retry-After). */
  rateLimited: boolean;
}

export type HttpProbe = (url: string, timeoutMs: number) => Promise<HttpResult>;
export type TlsProbe = (host: string, timeoutMs: number) => Promise<TlsResult>;
export type AuthProbe = (url: string, timeoutMs: number) => Promise<AuthAttemptResult>;
