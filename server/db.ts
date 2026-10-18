import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Opens the SQLite store and ensures the schema exists. The store holds the
 * ownership allowlist, append-only audit trail, scan records, and app state
 * (e.g. the kill switch). Schema is self-initializing so no migration step is
 * needed on deploy.
 */
export function openDb(dbPath?: string): Database.Database {
  const resolved =
    dbPath ?? join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "secval.sqlite");

  if (resolved !== ":memory:") {
    const dir = dirname(resolved);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowlist (
      domain            TEXT PRIMARY KEY,
      added_at          TEXT NOT NULL,
      notes             TEXT,
      ownership_proven  INTEGER NOT NULL DEFAULT 0,
      ownership_method  TEXT,
      proof_token       TEXT,
      proven_at         TEXT,
      active_eligible   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL,
      actor     TEXT NOT NULL,
      action    TEXT NOT NULL,
      target    TEXT,
      mode      TEXT,
      decision  TEXT NOT NULL,
      reason    TEXT,
      detail    TEXT
    );

    CREATE TABLE IF NOT EXISTS scans (
      id            TEXT PRIMARY KEY,
      target        TEXT NOT NULL,
      mode          TEXT NOT NULL,
      status        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      findings_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS findings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id    TEXT NOT NULL REFERENCES scans(id),
      severity   TEXT NOT NULL,
      code       TEXT NOT NULL,
      title      TEXT NOT NULL,
      detail     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Health dashboard: one row per uptime check of an app's home page.
    CREATE TABLE IF NOT EXISTS uptime_checks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      host       TEXT NOT NULL,
      ts         TEXT NOT NULL,
      ok         INTEGER NOT NULL,
      status     INTEGER,
      ms         INTEGER,
      error      TEXT
    );
    CREATE INDEX IF NOT EXISTS uptime_checks_host_ts ON uptime_checks (host, ts);

    -- Health dashboard: scores pasted in from reports (always estimates).
    CREATE TABLE IF NOT EXISTS health_reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      host       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      text       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_scores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id  INTEGER NOT NULL REFERENCES health_reports(id),
      host       TEXT NOT NULL,
      area       TEXT NOT NULL,
      label      TEXT NOT NULL,
      score      INTEGER NOT NULL,
      evidence   TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Enforce append-only on the audit trail at the database level: any
    -- UPDATE or DELETE is rejected, so the trail cannot be rewritten even by
    -- a bug elsewhere in the code.
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
      BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
}

export type DB = Database.Database;
