-- Secval monitoring login, LEAST PRIVILEGE. Step 1 of 2. Run ONCE PER DATABASE in the Neon SQL Editor,
-- as the role that owns your tables (usually neondb_owner), after replacing the placeholders.
-- Do not paste the password anywhere except this editor and the Render secret.
--
-- This creates a login that can connect and see schema METADATA (table, column, index and constraint names).
-- It can read NO table data at all until step 2 (the generated column-level grants).

CREATE ROLE secval_monitor WITH LOGIN PASSWORD '<PASSWORD>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;

-- Every session of this login is read-only with a time limit.
ALTER ROLE secval_monitor SET default_transaction_read_only = on;
ALTER ROLE secval_monitor SET statement_timeout = '15s';

GRANT CONNECT ON DATABASE <DB_NAME> TO secval_monitor;
GRANT USAGE ON SCHEMA public TO secval_monitor;

-- Deliberately NOT granted: SELECT on tables, ALTER DEFAULT PRIVILEGES, any other schema.
-- Step 2: Secval generates the exact "GRANT SELECT (key_columns) ON table ..." script from its own checks
-- (Database tab > app details > "Show required column grants", or scripts/dbarch-preflight.ts). You review it, then run it.
-- Tables created later are NOT readable until that script is regenerated and run again (by design).
