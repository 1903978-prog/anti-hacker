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
    // Database Architecture & Integrity module. Scan history and alerts are
    // append-only; the full latest result per app is replaced each scan.
    version: 5,
    name: "database architecture scorecard",
    sql: `
    CREATE TABLE IF NOT EXISTS dbarch_scans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      app           TEXT NOT NULL,
      tier          TEXT NOT NULL CHECK (tier IN ('quick','deep')),
      started_at    TEXT NOT NULL,
      finished_at   TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('ok','partial','error')),
      error_label   TEXT,
      calc_version  TEXT NOT NULL,
      fingerprint   TEXT,
      arch_score    REAL CHECK (arch_score IS NULL OR arch_score BETWEEN 0 AND 10),
      arch_coverage REAL,
      ready_score   REAL CHECK (ready_score IS NULL OR ready_score BETWEEN 0 AND 10),
      ready_coverage REAL,
      summary_json  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dbarch_scans_app_id ON dbarch_scans (app, id);
    CREATE TRIGGER IF NOT EXISTS dbarch_scans_no_update BEFORE UPDATE ON dbarch_scans
      BEGIN SELECT RAISE(ABORT, 'dbarch_scans is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS dbarch_scans_no_delete BEFORE DELETE ON dbarch_scans
      BEGIN SELECT RAISE(ABORT, 'dbarch_scans is append-only'); END;
    CREATE TABLE IF NOT EXISTS dbarch_latest (
      app         TEXT PRIMARY KEY,
      scan_id     INTEGER NOT NULL,
      updated_at  TEXT NOT NULL,
      deep_at     TEXT,
      result_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dbarch_alerts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      app        TEXT NOT NULL,
      scan_id    INTEGER,
      kind       TEXT NOT NULL,
      severity   TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dbarch_alerts_app_id ON dbarch_alerts (app, id);
    CREATE TRIGGER IF NOT EXISTS dbarch_alerts_no_update BEFORE UPDATE ON dbarch_alerts
      BEGIN SELECT RAISE(ABORT, 'dbarch_alerts is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS dbarch_alerts_no_delete BEFORE DELETE ON dbarch_alerts
      BEGIN SELECT RAISE(ABORT, 'dbarch_alerts is append-only'); END;
    CREATE TABLE IF NOT EXISTS dbarch_attestations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      app         TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       REAL,
      detail      TEXT,
      reason      TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS dbarch_attest_app_key ON dbarch_attestations (app, key, id);
    CREATE TRIGGER IF NOT EXISTS dbarch_attest_no_update BEFORE UPDATE ON dbarch_attestations
      BEGIN SELECT RAISE(ABORT, 'dbarch_attestations is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS dbarch_attest_no_delete BEFORE DELETE ON dbarch_attestations
      BEGIN SELECT RAISE(ABORT, 'dbarch_attestations is append-only'); END;
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
