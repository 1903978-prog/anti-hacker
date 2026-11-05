-- Secval monitoring login: read-only, least privilege. Run ONCE PER DATABASE in the Neon SQL Editor,
-- as the role that owns your tables (usually neondb_owner), after replacing the three <PLACEHOLDERS>.
-- Do not paste the password anywhere except this editor and the Render secret.

CREATE ROLE secval_monitor WITH LOGIN PASSWORD '<PASSWORD>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;

-- Belt and braces: every session of this login is read-only with a time limit.
ALTER ROLE secval_monitor SET default_transaction_read_only = on;
ALTER ROLE secval_monitor SET statement_timeout = '15s';

-- Minimum rights: connect, see the schema, read tables. Nothing else.
GRANT CONNECT ON DATABASE <DB_NAME> TO secval_monitor;
GRANT USAGE ON SCHEMA public TO secval_monitor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO secval_monitor;

-- Tables created later by the owner role stay readable without a manual step.
ALTER DEFAULT PRIVILEGES FOR ROLE <OWNER_ROLE> IN SCHEMA public GRANT SELECT ON TABLES TO secval_monitor;
