import type { RoQueryable } from "../server/dbarch/readonly.js";
import type { Session } from "../server/dbarch/connect.js";

export interface FakeTable {
  name: string;
  columns: Array<[name: string, type: string]>;
  pk?: string;
  fks?: Array<{ col: string; refTable: string; refCol: string }>;
  rows?: Array<Record<string, unknown>>;
  estRows?: number;
  indexes?: string[][];
  uniques?: number;
  checks?: number;
  triggers?: string[];
  publicGrant?: boolean;
  rls?: boolean;
}

/** In-memory stand-in for a monitored Postgres: answers secval's catalog and aggregate queries and logs every statement. */
export class FakePg implements Session, RoQueryable {
  log: string[] = [];
  closed = false;
  constructor(public tables: FakeTable[], public opts: { readOnly?: boolean; ledgerVersion?: string; perms?: Record<string, unknown> } = {}) {}

  async close(): Promise<void> { this.closed = true; }

  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.log.push(sql);
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
    const t = this.tables;
    if (/rolsuper/.test(sql)) {
      return { rows: [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false, db_create: false, schema_create: false, writable_tables: 0, owned_objects: 0, memberships: "", table_wide_select: 0, readable_columns: 10, sensitive_readable: 0, other_schemas: 0, tls: true, ...this.opts.perms }] };
    }
    if (/transaction_read_only/.test(sql)) return { rows: [{ v: this.opts.readOnly === false ? "off" : "on" }] };
    if (/has_pk/.test(sql)) return { rows: t.map((x) => ({ name: x.name, est: x.estRows ?? x.rows?.length ?? 0, has_pk: !!x.pk })) };
    if (/format_type/.test(sql)) return { rows: t.flatMap((x) => x.columns.map(([n, ty]) => ({ t: x.name, n, ty, nl: true }))) };
    if (/contype = 'f'/.test(sql)) {
      return { rows: t.flatMap((x) => (x.fks ?? []).map((f) => ({ name: `${x.name}_${f.col}_fkey`, tbl: x.name, ref: f.refTable, valid: true, cols: [f.col], refcols: [f.refCol] }))) };
    }
    if (/FROM pg_index/.test(sql)) {
      const rows: Array<Record<string, unknown>> = [];
      for (const x of t) {
        if (x.pk) rows.push({ name: `${x.name}_pkey`, tbl: x.name, uniq: true, valid: true, prim: true, cols: [x.pk] });
        for (const [i, cols] of (x.indexes ?? []).entries()) rows.push({ name: `${x.name}_ix${i}`, tbl: x.name, uniq: false, valid: true, prim: false, cols });
      }
      return { rows };
    }
    if (/contype IN \('u','c'\)/.test(sql)) {
      return { rows: t.flatMap((x) => [...Array(x.uniques ?? 0).keys()].map((i) => ({ name: `${x.name}_u${i}`, tbl: x.name, kind: "u" })).concat([...Array(x.checks ?? 0).keys()].map((i) => ({ name: `${x.name}_c${i}`, tbl: x.name, kind: "c" })))) };
    }
    if (/FROM pg_trigger/.test(sql)) return { rows: t.flatMap((x) => (x.triggers ?? []).map((n) => ({ tbl: x.name, name: n }))) };
    if (/relrowsecurity/.test(sql)) return { rows: t.filter((x) => x.rls).map((x) => ({ tbl: x.name })) };
    if (/aclexplode/.test(sql)) return { rows: t.filter((x) => x.publicGrant).map((x) => ({ tbl: x.name })) };
    if (/max\("/.test(sql)) return { rows: [{ v: this.opts.ledgerVersion ?? "0002" }] };
    const m = /c\."(\w+)" IS NOT NULL\) AS examined.*FROM "(\w+)" p WHERE p\."(\w+)" = .*FROM "(\w+)" c$/s.exec(sql);
    if (m) {
      const [, col, parent, pcol, child] = m;
      const rows = t.find((x) => x.name === child)!.rows ?? [];
      const prow = t.find((x) => x.name === parent)!.rows ?? [];
      const nn = rows.filter((r) => r[col!] != null);
      const bad = nn.filter((r) => !prow.some((p) => p[pcol!] === r[col!]));
      return { rows: [{ examined: nn.length, failures: bad.length }] };
    }
    throw new Error("FakePg: unexpected query");
  }
}

const idc = (n: string): [string, string] => [n, "integer"];
const ts = (): [string, string] => ["created_at", "timestamp with time zone"];

/** A small, healthy-ish schema with one external id and one genuine orphan. */
export function sampleTables(opts: { orphan?: boolean; withFk?: boolean } = {}): FakeTable[] {
  return [
    { name: "clients", columns: [idc("id"), ["name", "text"], ts()], pk: "id", uniques: 1, rows: [{ id: 1 }, { id: 2 }] },
    {
      name: "projects", columns: [idc("id"), idc("client_id"), ["stripe_customer_id", "text"], ts()], pk: "id", indexes: [["client_id"]],
      fks: opts.withFk ? [{ col: "client_id", refTable: "clients", refCol: "id" }] : [],
      rows: [{ id: 1, client_id: 1 }, { id: 2, client_id: 2 }, ...(opts.orphan ? [{ id: 3, client_id: 99 }] : [])],
    },
    { name: "audit_log", columns: [idc("id"), ["event", "text"], ts()], pk: "id", triggers: ["audit_log_no_update"], rows: [] },
    { name: "schema_migrations", columns: [["version", "text"]], pk: "version", rows: [{ version: "0001" }] },
    { name: "scratch", columns: [["note", "text"]], rows: [] },
  ];
}
