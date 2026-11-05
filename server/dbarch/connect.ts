import pg from "pg";
import type { RoQueryable } from "./readonly.js";

/**
 * Opens ONE short-lived read-only session to a monitored database. The
 * connection string comes from a server-side env var; errors are reduced to a
 * safe label so neither the string nor SQL text can reach logs or the browser.
 *
 * TLS is mandatory for every non-loopback host (certificate verified). The
 * session is a READ ONLY transaction with local timeouts. Nothing is sent as a
 * startup option, so it also works through Neon's pooled endpoint.
 */
export interface Session extends RoQueryable {
  close(): Promise<void>;
}
export type Connector = (connectionString: string) => Promise<Session>;

export class ConnectError extends Error {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Parses host/port without exposing the credentials. Throws ConnectError on a bad string. */
export function parseTarget(connectionString: string): { host: string; port: number; loopback: boolean; sslmode: string | null } {
  let u: URL;
  try { u = new URL(connectionString); } catch { throw new ConnectError("connection string is not a valid postgres URL"); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new ConnectError("connection string is not a postgres URL");
  const host = u.hostname.toLowerCase();
  return { host, port: Number(u.port) || 5432, loopback: LOOPBACK.has(host) || host.startsWith("/"), sslmode: u.searchParams.get("sslmode") };
}

/** TLS must be required for any host that is not this machine. */
export function assertTlsRequired(connectionString: string): void {
  const t = parseTarget(connectionString);
  if (t.loopback) return;
  if (!t.sslmode || !["require", "verify-ca", "verify-full"].includes(t.sslmode)) {
    throw new ConnectError("TLS is required: add ?sslmode=require to the connection string");
  }
}

export const pgConnector: Connector = async (connectionString) => {
  const target = parseTarget(connectionString);
  assertTlsRequired(connectionString);
  // Our own ssl setting wins over any sslmode in the URL: verified certificate, never plaintext.
  const cleaned = new URL(connectionString);
  cleaned.searchParams.delete("sslmode");
  const client = new pg.Client({
    connectionString: cleaned.toString(),
    ssl: target.loopback ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 8_000,
    query_timeout: 12_000,
    application_name: "secval-dbarch-readonly",
  });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 10000");
    await client.query("SET LOCAL lock_timeout = 2000");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = 120000");
  } catch {
    try { await client.end(); } catch { /* already closed */ }
    throw new ConnectError("could not open a read-only session");
  }
  return {
    query: async (sql, params) => {
      const r = await client.query(sql, params as unknown[]);
      return { rows: r.rows as Array<Record<string, unknown>> };
    },
    close: async () => {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      try { await client.end(); } catch { /* ignore */ }
    },
  };
};
