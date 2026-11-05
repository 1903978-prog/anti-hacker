/**
 * The ONLY way secval talks to a monitored database. Every statement must be
 * a single read-only SELECT / WITH...SELECT; anything else is refused before
 * it leaves this process. The session is also put in READ ONLY mode with a
 * statement timeout, so even a bug cannot write.
 */
export class ReadOnlyViolation extends Error {}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|cluster|refresh|comment|lock|set\s+role|set\s+session|reset|listen|notify|prepare|execute|merge|import)\b/i;

export function assertReadOnlySql(sql: string): void {
  const s = sql.trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new ReadOnlyViolation("multiple statements are not allowed");
  if (!/^(select|with)\b/i.test(s)) throw new ReadOnlyViolation("only SELECT statements are allowed");
  // Strip string literals before keyword scan so e.g. 'update' as a value is fine.
  const bare = s.replace(/'(?:[^']|'')*'/g, "''");
  if (FORBIDDEN.test(bare)) throw new ReadOnlyViolation("statement contains a write/DDL keyword");
  if (/\bfor\s+(update|share|no\s+key\s+update)\b/i.test(bare)) throw new ReadOnlyViolation("locking reads are not allowed");
}

export interface RoQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Wraps a connected client so every call is checked. */
export function readOnly(client: RoQueryable): RoQueryable {
  return {
    async query(sql, params) {
      assertReadOnlySql(sql);
      return client.query(sql, params);
    },
  };
}

/** Double-quotes an identifier after checking it came from the catalog (no quote injection). */
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new ReadOnlyViolation(`unsafe identifier: ${name.slice(0, 40)}`);
  return `"${name}"`;
}

/**
 * Runs one read-only statement inside a SAVEPOINT, so a refused statement
 * (for example "permission denied" under least privilege) does not abort the
 * session's transaction and the next check can still run.
 */
export async function isolated(raw: RoQueryable, sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
  const guarded = readOnly(raw);
  assertReadOnlySql(sql);
  await raw.query("SAVEPOINT secval_stmt");
  try {
    const out = await guarded.query(sql, params);
    await raw.query("RELEASE SAVEPOINT secval_stmt");
    return out;
  } catch (e) {
    await raw.query("ROLLBACK TO SAVEPOINT secval_stmt").catch(() => undefined);
    throw e;
  }
}
