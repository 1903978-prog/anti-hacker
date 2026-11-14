-- Throwaway fixture schema for the database scorecard tests (synthetic data only).
CREATE TABLE clients (id integer PRIMARY KEY, name text NOT NULL, created_at timestamptz DEFAULT now(), CONSTRAINT clients_name_uq UNIQUE (name));
CREATE TABLE projects (id integer PRIMARY KEY, client_id integer, owner_ref_id text, created_at timestamptz DEFAULT now());
CREATE TABLE invoices (id integer PRIMARY KEY, project_id integer, client_id integer REFERENCES clients(id), amount numeric CHECK (amount >= 0), created_at timestamptz DEFAULT now());
CREATE TABLE notes (note text, project_id integer);
CREATE TABLE audit_log (id integer PRIMARY KEY, event text, created_at timestamptz DEFAULT now());
CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now());
CREATE INDEX invoices_project_idx ON invoices (project_id);
CREATE INDEX invoices_project_idx_dup ON invoices (project_id);
INSERT INTO clients VALUES (1, 'Alpha'), (2, 'Beta');
INSERT INTO projects VALUES (1, 1, 'ext-1'), (2, 2, 'ext-2'), (3, 99, 'ext-3');   -- project 3 is a genuine orphan (client 99 missing)
INSERT INTO invoices VALUES (1, 1, 1, 10), (2, 2, 2, 20), (3, NULL, 1, 30);
INSERT INTO schema_migrations VALUES ('0001'), ('0002');
GRANT SELECT ON notes TO PUBLIC;
