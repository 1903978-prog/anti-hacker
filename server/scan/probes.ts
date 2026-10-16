import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { AuthAttemptResult, DnsRecords, HttpResult, TlsResult } from "./types.js";

/**
 * Real passive probes. Both are read-only: a single GET and a TLS handshake.
 * Neither mutates the target, and response bodies are discarded unread.
 */

export async function httpProbe(url: string, timeoutMs: number, method = "GET"): Promise<HttpResult> {
  const res = await fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "secval-passive/0.1 (+authorized self-scan)" },
  });

  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Capture Set-Cookie separately (fetch folds them in getSetCookie()).
  const setCookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];

  // Discard the body without reading it into retained memory.
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }

  return { status: res.status, headers, setCookies };
}

/**
 * A single login-hardening probe: one POST of deliberately-invalid, random
 * credentials to a login endpoint. It is NOT credential stuffing and NOT user
 * enumeration — the username is a fresh random non-existent value and the
 * password is random, so no real account is ever targeted and a correct login
 * is impossible. A failed login mutates no data. Only the status and whether
 * the server throttled is returned; the response body is discarded unread.
 */
export async function authProbe(url: string, timeoutMs: number): Promise<AuthAttemptResult> {
  const nonce = randomBytes(9).toString("hex");
  const body = new URLSearchParams({
    username: `secval-nouser-${nonce}`,
    email: `secval-nouser-${nonce}@example.invalid`,
    password: randomBytes(16).toString("hex"),
  });

  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "user-agent": "secval-active/0.1 (+authorized self-scan)",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const retryAfter = res.headers.has("retry-after");
  const rateLimited = res.status === 429 || res.status === 423 || retryAfter;

  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }

  return { status: res.status, rateLimited };
}

/**
 * Read-only DNS lookups for email/domain security records. Never touches the
 * target's HTTP server; failures (no such record) resolve to empty lists.
 */
export async function dnsProbe(host: string): Promise<DnsRecords> {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  const txtAt = async (name: string): Promise<string[]> => {
    try {
      const records = await resolver.resolveTxt(name);
      return records.map((chunks) => chunks.join(""));
    } catch {
      return [];
    }
  };
  const caaAt = async (name: string): Promise<string[]> => {
    try {
      const records = await resolver.resolveCaa(name);
      return records.map((r) => JSON.stringify(r));
    } catch {
      return [];
    }
  };

  const [txt, dmarcTxt, caa] = await Promise.all([
    txtAt(host),
    txtAt(`_dmarc.${host}`),
    caaAt(host),
  ]);
  return { txt, dmarcTxt, caa };
}

export function tlsProbe(host: string, timeoutMs: number): Promise<TlsResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: TlsResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        done({
          protocol: socket.getProtocol(),
          validTo: cert && cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
          authorized: socket.authorized,
          authorizationError: socket.authorized ? null : String(socket.authorizationError ?? ""),
        });
      },
    );

    socket.on("timeout", () =>
      done({ protocol: null, validTo: null, authorized: false, authorizationError: "timeout" }),
    );
    socket.on("error", (err) =>
      done({ protocol: null, validTo: null, authorized: false, authorizationError: err.message }),
    );
  });
}
