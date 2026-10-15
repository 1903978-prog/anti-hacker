import tls from "node:tls";
import type { HttpResult, TlsResult } from "./types.js";

/**
 * Real passive probes. Both are read-only: a single GET and a TLS handshake.
 * Neither mutates the target, and response bodies are discarded unread.
 */

export async function httpProbe(url: string, timeoutMs: number): Promise<HttpResult> {
  const res = await fetch(url, {
    method: "GET",
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
