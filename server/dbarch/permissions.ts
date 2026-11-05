import { readOnly, type RoQueryable } from "./readonly.js";

export interface PermissionCheck { id: string; label: string; ok: boolean | null; detail: string }
export interface PermissionReport {
  checkedAt: string;
  /** True only when every hard check passed (no write/DDL/admin privilege in effect). */
  leastPrivilege: boolean | null;
  tls: boolean | null;
  selectableTables: number | null;
  checks: PermissionCheck[];
}

/** Roles that would let a monitoring login write, read files or run programs. */
const DANGEROUS_ROLES = ["neon_superuser", "pg_write_all_data", "pg_execute_server_program", "pg_write_server_files", "pg_read_server_files", "pg_signal_backend", "pg_checkpoint", "pg_maintain", "pg_database_owner"];

export const PERMISSION_SQL = `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication,
  has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
  has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND (has_any_column_privilege(current_user, c.oid, 'INSERT') OR has_any_column_privilege(current_user, c.oid, 'UPDATE') OR has_table_privilege(current_user, c.oid, 'DELETE') OR has_table_privilege(current_user, c.oid, 'TRUNCATE') OR has_any_column_privilege(current_user, c.oid, 'REFERENCES') OR has_table_privilege(current_user, c.oid, 'TRIGGER'))) AS writable_tables,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owned_objects,
  (SELECT coalesce(string_agg(g.rolname::text, ','), '') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS memberships,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND has_any_column_privilege(current_user, c.oid, 'SELECT')) AS selectable_tables,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND has_table_privilege(current_user, c.oid, 'SELECT')) AS whole_table_select,
  (SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()) AS tls
FROM pg_roles r WHERE r.rolname = current_user`;

/**
 * Verifies the EFFECTIVE permissions of the monitoring login, from the
 * database's own privilege functions (so group memberships and defaults are
 * included). Any write, DDL, ownership or admin privilege makes the scan fail closed.
 */
export async function verifyPermissions(rawClient: RoQueryable, now: Date = new Date()): Promise<PermissionReport> {
  const c = readOnly(rawClient);
  const r = (await c.query(PERMISSION_SQL)).rows[0];
  if (!r) return { checkedAt: now.toISOString(), leastPrivilege: null, tls: null, selectableTables: null, checks: [{ id: "role", label: "Monitoring role readable", ok: null, detail: "Could not read the role's attributes." }] };
  const memberships = String(r.memberships ?? "").split(",").filter(Boolean);
  const bad = memberships.filter((m) => DANGEROUS_ROLES.includes(m));
  const n = (v: unknown) => Number(v ?? 0);
  const checks: PermissionCheck[] = [
    { id: "attrs", label: "Not superuser / createdb / createrole / bypassrls / replication", ok: !(r.rolsuper || r.rolcreatedb || r.rolcreaterole || r.rolbypassrls || r.rolreplication), detail: "pg_roles attributes of the login" },
    { id: "db_create", label: "No CREATE on the database", ok: !r.db_create, detail: "has_database_privilege(..., 'CREATE')" },
    { id: "schema_create", label: "No CREATE on schema public", ok: !r.schema_create, detail: "has_schema_privilege(..., 'CREATE')" },
    { id: "writable", label: "No INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER on any public table", ok: n(r.writable_tables) === 0, detail: `${n(r.writable_tables)} table(s) with a write-type privilege` },
    { id: "owner", label: "Owns no objects in public", ok: n(r.owned_objects) === 0, detail: `${n(r.owned_objects)} owned object(s)` },
    { id: "roles", label: "Member of no privileged role", ok: bad.length === 0, detail: bad.length ? `member of ${bad.join(", ")}` : memberships.length ? `member of ${memberships.join(", ")} (not privileged)` : "no memberships" },
    { id: "select", label: "Has SELECT on tables it must read", ok: n(r.selectable_tables) > 0, detail: `${n(r.selectable_tables)} table(s) readable` },
    { id: "column_only", label: "SELECT is limited to key columns (no whole-table SELECT)", ok: n(r.whole_table_select) === 0, detail: `${n(r.whole_table_select)} table(s) readable in full; use docs/sql/dbarch-monitor-role.sql v2` },
    { id: "tls", label: "Connection uses TLS", ok: r.tls === null || r.tls === undefined ? null : Boolean(r.tls), detail: "pg_stat_ssl (the client also refuses plaintext for any remote host)" },
  ];
  const hard = checks.filter((x) => x.id !== "tls" && x.id !== "select" && x.id !== "column_only");
  return {
    checkedAt: now.toISOString(),
    leastPrivilege: hard.every((x) => x.ok === true),
    tls: checks.find((x) => x.id === "tls")!.ok,
    selectableTables: n(r.selectable_tables),
    checks,
  };
}
