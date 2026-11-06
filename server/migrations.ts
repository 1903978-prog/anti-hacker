import type Database from "better-sqlite3";

/**
 * Tracked schema changes. initSchema() in db.ts is the baseline (version 1);
 * every change after it is a numbered migration below. Each runs once, inside
 * a transaction, and is recorded in schema_migrations so an old database
 * picks up exactly the changes it is missing. Never edit a migration that has
 * shipped: add a new one instead.
 */
export type Migration = { version: number; name: string; sql: string };

/** Fails a write with a clear message unless `cond` holds for the new row. */
function rule(table: string, name: string, cond: string, msg: string): string {
  return ["INSERT", "UPDATE"]
    .map(
      (op) => `
    CREATE TRIGGER IF NOT EXISTS ${table}_${name}_${op.toLowerCase()}
      BEFORE ${op} ON ${table}
      WHEN NOT (${cond})
      BEGIN SELECT RAISE(ABORT, '${msg}'); END;`,
    )
    .join("\n");
}

export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: "indexes on main lookups",
    sql: `
    CREATE INDEX IF NOT EXISTS findings_scan_id ON findings (scan_id);
    CREATE INDEX IF NOT EXISTS scans_target_status_finished ON scans (target, status, finished_at);
    CREATE INDEX IF NOT EXISTS scans_started_at ON scans (started_at);
    CREATE INDEX IF NOT EXISTS health_reports_host_created ON health_reports (host, created_at);
    CREATE INDEX IF NOT EXISTS health_scores_host_created ON health_scores (host, created_at);
    CREATE INDEX IF NOT EXISTS health_scores_report_id ON health_scores (report_id);
    CREATE INDEX IF NOT EXISTS health_infra_host_created ON health_infra (host, created_at);
    CREATE INDEX IF NOT EXISTS health_infra_report_id ON health_infra (report_id);
    `,
  },
  {
    // SQLite cannot add CHECK rules to an existing table without rebuilding
    // it, so the rules are triggers: they guard every new write and leave
    // rows already stored untouched.
    version: 3,
    name: "value rules on scans, findings, scores and uptime",
    sql: [
      rule("scans", "mode", "NEW.mode IN ('passive', 'active')", "scans.mode must be passive or active"),
      rule(
        "scans",
        "status",
        "NEW.status IN ('running', 'completed', 'aborted')",
        "scans.status must be running, completed or aborted",
      ),
      rule("scans", "count", "NEW.findings_count >= 0", "scans.findings_count cannot be negative"),
      rule(
        "findings",
        "severity",
        "NEW.severity IN ('high', 'medium', 'low', 'info')",
        "findings.severity must be high, medium, low or info",
      ),
      rule("health_scores", "range", "NEW.score BETWEEN 0 AND 100", "health_scores.score must be 0 to 100"),
      rule("uptime_checks", "ok", "NEW.ok IN (0, 1)", "uptime_checks.ok must be 0 or 1"),
    ].join("\n"),
  },
  {
    // Data-quality audit: one immutable row per Refresh, plus the last
    // trustworthy snapshot (record fingerprints only, never values).
    version: 4,
    name: "data quality runs and snapshots",
    sql: `
    CREATE TABLE IF NOT EXISTS quality_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id         TEXT NOT NULL UNIQUE,
      app            TEXT NOT NULL,
      module         TEXT NOT NULL,
      page           TEXT NOT NULL,
      dataset        TEXT NOT NULL,
      dataset_code   TEXT,
      table_name     TEXT NOT NULL,
      source_system  TEXT NOT NULL,
      initiator      TEXT NOT NULL,
      kind           TEXT NOT NULL,
      started_at     TEXT NOT NULL,
      finished_at    TEXT NOT NULL,
      evaluated_at   TEXT NOT NULL,
      outcome        TEXT NOT NULL CHECK (outcome IN ('PASS','FAIL','UNVERIFIED')),
      status         TEXT NOT NULL,
      score          REAL CHECK (score IS NULL OR score BETWEEN 0 AND 100),
      raw_score      REAL,
      coverage       REAL NOT NULL,
      critical       INTEGER NOT NULL CHECK (critical IN (0, 1)),
      policy_version TEXT NOT NULL,
      spec_version   TEXT,
      record_count   INTEGER NOT NULL,
      result_json    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS quality_runs_dataset_id ON quality_runs (dataset, id);
    CREATE INDEX IF NOT EXISTS quality_runs_app_id ON quality_runs (app, id);
    CREATE TRIGGER IF NOT EXISTS quality_runs_no_update BEFORE UPDATE ON quality_runs
      BEGIN SELECT RAISE(ABORT, 'quality_runs is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS quality_runs_no_delete BEFORE DELETE ON quality_runs
      BEGIN SELECT RAISE(ABORT, 'quality_runs is append-only'); END;
    CREATE TABLE IF NOT EXISTS quality_snapshots (
      dataset      TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL,
      taken_at     TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      fingerprints TEXT NOT NULL
    );
    `,
  },
  {
    // Database structure checks: one append-only row per hourly check of an
    // app's own database report (score and rule notes only, never row data).
    version: 5,
    name: "database structure checks",
    sql: `
    CREATE TABLE IF NOT EXISTS db_checks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      host       TEXT NOT NULL,
      ts         TEXT NOT NULL,
      ok         INTEGER NOT NULL CHECK (ok IN (0, 1)),
      score      INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
      rules_json TEXT NOT NULL,
      error      TEXT
    );
    CREATE INDEX IF NOT EXISTS db_checks_host_id ON db_checks (host, id);
    CREATE TRIGGER IF NOT EXISTS db_checks_no_update BEFORE UPDATE ON db_checks
      BEGIN SELECT RAISE(ABORT, 'db_checks is append-only'); END;
    `,
  },
];

/** Applies every migration the database has not seen yet; returns their versions. */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'baseline (initSchema)', datetime('now'));
  `);
  const done = new Set(
    (db.prepare(`SELECT version FROM schema_migrations`).all() as { version: number }[]).map((r) => r.version),
  );
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`).run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
    applied.push(m.version);
  }
  return applied;
}
