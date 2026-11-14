-- Verify the secval_monitor login BEFORE anything is merged or deployed. Read-only; run in the Neon SQL Editor
-- as the owner role (it only inspects privileges, it never connects as the login and needs no password).
-- Expected: every row says PASS (the two rows marked INFO are for you to read).
WITH t AS (
  SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
), col AS (
  SELECT t.relname, a.attname, a.attnum, t.oid FROM t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
)
SELECT 'role exists, login only, no super/createdb/createrole/replication/bypassrls' AS check,
       CASE WHEN r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) THEN 'PASS' ELSE 'FAIL' END AS result, '' AS detail
  FROM pg_roles r WHERE r.rolname = 'secval_monitor'
UNION ALL SELECT 'sessions are read-only with a time limit',
       CASE WHEN array_to_string(r.rolconfig, ',') LIKE '%default_transaction_read_only=on%' AND array_to_string(r.rolconfig, ',') LIKE '%statement_timeout%' THEN 'PASS' ELSE 'FAIL' END, array_to_string(r.rolconfig, ',')
  FROM pg_roles r WHERE r.rolname = 'secval_monitor'
UNION ALL SELECT 'member of no other role (so no inherited rights)',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, coalesce(string_agg(g.rolname::text, ','), '')
  FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'secval_monitor'
UNION ALL SELECT 'owns nothing in this database',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, ''
  FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'secval_monitor'
UNION ALL SELECT 'no INSERT/UPDATE/REFERENCES on any column, no DELETE/TRUNCATE/TRIGGER on any table',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, coalesce(string_agg(relname, ','), '')
  FROM t WHERE has_any_column_privilege('secval_monitor', oid, 'INSERT') OR has_any_column_privilege('secval_monitor', oid, 'UPDATE')
            OR has_any_column_privilege('secval_monitor', oid, 'REFERENCES') OR has_table_privilege('secval_monitor', oid, 'DELETE')
            OR has_table_privilege('secval_monitor', oid, 'TRUNCATE') OR has_table_privilege('secval_monitor', oid, 'TRIGGER')
UNION ALL SELECT 'no whole-table SELECT on any table',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, coalesce(string_agg(relname, ','), '')
  FROM t WHERE has_table_privilege('secval_monitor', oid, 'SELECT')
UNION ALL SELECT 'every readable column is a key or *_id column or a migration-version column',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, coalesce(string_agg(relname || '.' || attname, ','), '')
  FROM col WHERE has_column_privilege('secval_monitor', oid, attnum, 'SELECT')
    AND attname !~* '_id$'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype IN ('p','u','f') AND ((k.conrelid = col.oid AND col.attnum = ANY (k.conkey)) OR (k.confrelid = col.oid AND col.attnum = ANY (k.confkey))))
    AND NOT (relname IN ('schema_migrations','_prisma_migrations','__drizzle_migrations','knex_migrations','migrations','_migrations','alembic_version','flyway_schema_history') AND attname IN ('version','id','name','migration_name','installed_rank'))
UNION ALL SELECT 'content-looking columns are NOT readable (email, name, phone, password, token, secret, note, body, text)',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, coalesce(string_agg(relname || '.' || attname, ','), '')
  FROM col WHERE has_column_privilege('secval_monitor', oid, attnum, 'SELECT') AND attname ~* '(email|name|phone|passw|token|secret|note|body|text|address|comment)'
    AND NOT (relname IN ('schema_migrations','_prisma_migrations','__drizzle_migrations','knex_migrations','migrations','_migrations','alembic_version','flyway_schema_history'))
UNION ALL SELECT 'cannot CREATE in the database or in schema public',
       CASE WHEN NOT has_database_privilege('secval_monitor', current_database(), 'CREATE') AND NOT has_schema_privilege('secval_monitor', 'public', 'CREATE') THEN 'PASS' ELSE 'FAIL' END, ''
UNION ALL SELECT 'INFO: columns it can read / tables it can reach (compare with your table count)', 'INFO',
       (SELECT count(*) FROM col WHERE has_column_privilege('secval_monitor', oid, attnum, 'SELECT'))::text || ' columns in ' ||
       (SELECT count(*) FROM t WHERE has_any_column_privilege('secval_monitor', oid, 'SELECT'))::text || ' of ' || (SELECT count(*) FROM t)::text || ' tables'
UNION ALL SELECT 'INFO: other databases in this Neon project the login could open (it has no rights inside them)', 'INFO',
       coalesce((SELECT string_agg(datname, ',') FROM pg_database WHERE datallowconn AND datname <> current_database() AND has_database_privilege('secval_monitor', datname, 'CONNECT')), 'none');
