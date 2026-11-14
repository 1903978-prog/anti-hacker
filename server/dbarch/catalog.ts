import type { Catalog, TableInfo } from "./types.js";
import { createHash } from "node:crypto";
import { isolated, readOnly, type RoQueryable } from "./readonly.js";

const S = "public";
const LEDGER_NAMES = ["schema_migrations", "_prisma_migrations", "__drizzle_migrations", "knex_migrations", "migrations", "_migrations", "alembic_version", "flyway_schema_history"];

/**
 * Reads schema METADATA from pg_catalog for the public schema. No table rows
 * are read (the one exception is the newest version string of a migration
 * ledger, which is a version label, never business data).
 */
export async function collectCatalog(rawClient: RoQueryable, now: Date = new Date()): Promise<Catalog> {
  const c = readOnly(rawClient);
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;

  const ro = await q(`SELECT current_setting('transaction_read_only') AS v`).catch(() => []);
  const sessionReadOnly = ro.length ? String(ro[0]!.v) === "on" : null;

  const tableRows = await q(
    `SELECT c.relname AS name, c.reltuples::bigint AS est,
            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p') AS has_pk
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') ORDER BY c.relname`,
    [S],
  );
  // pg_attribute (not information_schema.columns) so columns stay visible to a login that has no table privileges.
  const colRows = await q(
    `SELECT c.relname AS t, a.attname::text AS n, format_type(a.atttypid, NULL) AS ty, (NOT a.attnotnull) AS nl
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`,
    [S],
  );
  const fkRows = await q(
    `SELECT k.conname AS name, c.relname AS tbl, r.relname AS ref, k.convalidated AS valid,
            (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS cols,
            (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum) AS refcols
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class r ON r.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'f' AND n.nspname = $1`,
    [S],
  );
  const idxRows = await q(
    `SELECT i.relname AS name, t.relname AS tbl, x.indisunique AS uniq, x.indisvalid AS valid, x.indisprimary AS prim,
            (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY u(attnum, ord) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum WHERE u.attnum > 0) AS cols
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1`,
    [S],
  );
  const conRows = await q(
    `SELECT k.conname AS name, c.relname AS tbl, k.contype AS kind FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND k.contype IN ('u','c')`,
    [S],
  );
  const trigRows = await q(
    `SELECT c.relname AS tbl, t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal`,
    [S],
  );
  const rlsRows = await q(
    `SELECT c.relname AS tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND c.relrowsecurity`,
    [S],
  );
  const grantRows = await q(
    `SELECT c.relname AS tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) x WHERE x.grantee = 0)`,
    [S],
  );

  const names = new Set(tableRows.map((r) => String(r.tbl ?? r.name)));
  const ledgers = LEDGER_NAMES.filter((n) => names.has(n));
  let latest: string | null = null;
  let ledgerColumn: string | null = null;
  if (ledgers.length) {
    // Version label only. Identifier comes from our fixed allowlist above.
    const colCandidates = ["version", "id", "name", "migration_name", "installed_rank"];
    const cols = colRows.filter((r) => r.t === ledgers[0]).map((r) => String(r.n));
    const col = colCandidates.find((x) => cols.includes(x));
    if (col) {
      ledgerColumn = col;
      // Needs a column grant; without one (least privilege) the version simply stays unread.
      const r = await isolated(rawClient, `SELECT max("${col}")::text AS v FROM "${ledgers[0]}"`).then((x) => x.rows).catch(() => []);
      latest = r.length && r[0]!.v != null ? String(r[0]!.v).slice(0, 80) : null;
    }
  }

  const colsByTable = new Map<string, string[]>();
  for (const r of colRows) {
    const t = String(r.t);
    if (!colsByTable.has(t)) colsByTable.set(t, []);
    colsByTable.get(t)!.push(String(r.n));
  }
  const tables: TableInfo[] = tableRows.map((r) => ({
    name: String(r.name),
    estRows: Number(r.est ?? -1),
    columns: colsByTable.get(String(r.name)) ?? [],
    hasPrimaryKey: Boolean(r.has_pk),
  }));

  return {
    collectedAt: now.toISOString(),
    tables,
    columns: colRows.map((r) => ({ table: String(r.t), name: String(r.n), type: String(r.ty), nullable: Boolean(r.nl) })),
    foreignKeys: fkRows.map((r) => ({
      name: String(r.name), table: String(r.tbl), columns: (r.cols as string[]) ?? [], refTable: String(r.ref), refColumns: (r.refcols as string[]) ?? [], validated: Boolean(r.valid),
    })),
    indexes: idxRows.map((r) => ({
      name: String(r.name), table: String(r.tbl), columns: (r.cols as string[]) ?? [], unique: Boolean(r.uniq), valid: Boolean(r.valid), primary: Boolean(r.prim),
    })),
    constraints: conRows.map((r) => ({ name: String(r.name), table: String(r.tbl), kind: r.kind === "u" ? "unique" : "check" })),
    triggers: trigRows.map((r) => ({ table: String(r.tbl), name: String(r.name) })),
    rlsEnabledTables: rlsRows.map((r) => String(r.tbl)),
    publicGrantTables: grantRows.map((r) => String(r.tbl)),
    migrationLedgers: ledgers,
    migrationLatest: latest,
    migrationLedgerColumn: ledgerColumn,
    sessionReadOnly,
  };
}

/** Stable fingerprint of schema shape; changes when any table/column/FK/index/constraint changes. */
export function schemaFingerprint(cat: Catalog): string {
  const parts = [
    ...cat.tables.map((t) => `T:${t.name}:${t.hasPrimaryKey}`),
    ...cat.columns.map((c) => `C:${c.table}.${c.name}:${c.type}:${c.nullable}`),
    ...cat.foreignKeys.map((f) => `F:${f.table}(${f.columns})->${f.refTable}(${f.refColumns}):${f.validated}`),
    ...cat.indexes.map((i) => `I:${i.table}:${i.name}:${i.columns}:${i.unique}:${i.valid}`),
    ...cat.constraints.map((k) => `K:${k.table}:${k.name}:${k.kind}`),
  ].sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
