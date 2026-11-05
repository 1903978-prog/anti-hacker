-- Secval monitoring login v2: read-only, LEAST privilege. Run ONCE PER DATABASE in the Neon SQL Editor
-- as the role that owns your tables (usually neondb_owner), after replacing the two <PLACEHOLDERS>.
-- Do not paste the password anywhere except this editor and the Render secret.
--
-- v2 change (05 Nov 2026): NO table-wide SELECT and NO default privileges on future tables.
-- The login can read ONLY key columns (primary key, unique, foreign key and *_id columns) plus the
-- version column of a migration ledger. It cannot read names, e-mails, notes, passwords or any other
-- content column, and a table created later is invisible to it until section 3 is run again.

-- 1. The login (read-only sessions, 15 s limit, 3 connections at most).
CREATE ROLE secval_monitor WITH LOGIN PASSWORD '<PASSWORD>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
ALTER ROLE secval_monitor SET default_transaction_read_only = on;
ALTER ROLE secval_monitor SET statement_timeout = '15s';

-- 2. Connect and see the schema. Nothing else (no CREATE).
GRANT CONNECT ON DATABASE <DB_NAME> TO secval_monitor;
GRANT USAGE ON SCHEMA public TO secval_monitor;

-- 3. Column-level SELECT on key columns only. SAFE TO RE-RUN after your schema changes
--    (it first removes every table-level and column-level right it gave, then grants again).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p') LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM secval_monitor', r.relname);
  END LOOP;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.attname AS col
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
       AND ( a.attname ~* '_id$'
          OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype IN ('p','u','f')
                       AND ((k.conrelid = c.oid AND a.attnum = ANY (k.conkey))
                         OR (k.confrelid = c.oid AND a.attnum = ANY (k.confkey))))
          OR (c.relname IN ('schema_migrations','_prisma_migrations','__drizzle_migrations','knex_migrations',
                            'migrations','_migrations','alembic_version','flyway_schema_history')
              AND a.attname IN ('version','id','name','migration_name','installed_rank')) )
  LOOP
    EXECUTE format('GRANT SELECT (%I) ON TABLE public.%I TO secval_monitor', r.col, r.tbl);
  END LOOP;
END $$;
