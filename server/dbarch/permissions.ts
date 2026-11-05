import { readOnly, type RoQueryable } from "./readonly.js";

export interface PermissionCheck { id: string; label: string; ok: boolean | null; detail: string }
export interface PermissionReport {
  checkedAt: string;
  /** True only when every hard check passed (no write/DDL/admin privilege in effect). */
  leastPrivilege: boolean | null;
  tls: boolean | null;
  /** Columns the login can read (column-level grants only). */
  readableColumns: number | null;
  checks: PermissionCheck[];
}

/** Roles that would let a monitoring login write, read files or run programs. */
const DANGEROUS_ROLES = ["neon_superuser", "pg_write_all_data", "pg_execute_server_program", "pg_write_server_files", "pg_read_server_files", "pg_signal_backend", "pg_checkpoint", "pg_maintain", "pg_database_owner"];

/** Column names that look personal or secret. A login must not be able to read these. */
export const SENSITIVE_RE = "(email|passw|secret|token|salary|ssn|iban|phone|birth|api_?key|credential|address)";

export const PERMISSION_SQL = `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication,
  has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
  has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE') OR has_table_privilege(current_user, c.oid, 'DELETE') OR has_table_privilege(current_user, c.oid, 'TRUNCATE') OR has_table_privilege(current_user, c.oid, 'REFERENCES') OR has_table_privilege(current_user, c.oid, 'TRIGGER'))) AS writable_tables,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owned_objects,
  (SELECT coalesce(string_agg(g.rolname::text, ','), '') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS memberships,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND has_table_privilege(current_user, c.oid, 'SELECT')) AS table_wide_select,
  (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')) AS readable_columns,
  (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~* '${SENSITIVE_RE}' AND has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')) AS sensitive_readable,
  (SELECT count(*) FROM pg_namespace n WHERE n.nspname NOT IN ('public','information_schema') AND n.nspname !~ '^pg_' AND has_schema_privilege(current_user, n.oid, 'USAGE')) AS other_schemas,
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
  if (!r) return { checkedAt: now.toISOString(), leastPrivilege: null, tls: null, readableColumns: null, checks: [{ id: "role", label: "Monitoring role readable", ok: null, detail: "Could not read the role's attributes." }] };
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
    { id: "wide_select", label: "No table-wide SELECT (column-level grants only)", ok: n(r.table_wide_select) === 0, detail: `${n(r.table_wide_select)} table(s) readable as a whole` },
    { id: "sensitive", label: "Cannot read personal or secret-looking columns", ok: n(r.sensitive_readable) === 0, detail: `${n(r.sensitive_readable)} such column(s) readable` },
    { id: "schemas", label: "No access to schemas other than public", ok: n(r.other_schemas) === 0, detail: `${n(r.other_schemas)} other schema(s) usable` },
    { id: "select", label: "Columns it may read (needed for orphan checks)", ok: n(r.readable_columns) > 0 ? true : null, detail: n(r.readable_columns) > 0 ? `${n(r.readable_columns)} key column(s) readable` : "none yet: orphan checks stay N/V until the generated column grants are applied" },
    { id: "tls", label: "Connection uses TLS", ok: r.tls === null || r.tls === undefined ? null : Boolean(r.tls), detail: "pg_stat_ssl (the client also refuses plaintext for any remote host)" },
  ];
  const hard = checks.filter((x) => x.id !== "tls" && x.id !== "select");
  return {
    checkedAt: now.toISOString(),
    leastPrivilege: hard.every((x) => x.ok === true),
    tls: checks.find((x) => x.id === "tls")!.ok,
    readableColumns: n(r.readable_columns),
    checks,
  };
}
