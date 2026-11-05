import pg from "pg";
import type { RoQueryable } from "./readonly.js";

/**
 * Opens ONE short-lived read-only session to a monitored database. The
 * connection string comes from a server-side env var; errors are reduced to a
 * safe label so neither the string nor SQL text can reach logs or the browser.
 */
export interface Session extends RoQueryable {
  close(): Promise<void>;
}
export type Connector = (connectionString: string) => Promise<Session>;

export class ConnectError extends Error {}

export const pgConnector: Connector = async (connectionString) => {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    application_name: "secval-dbarch-readonly",
    options: "-c default_transaction_read_only=on",
  });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
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
