import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openDb, initSchema } from "../server/db.js";
import { runMigrations, MIGRATIONS } from "../server/migrations.js";

const now = "2026-10-18T00:00:00.000Z";

describe("schema migrations", () => {
  it("records every migration once, and re-opening applies nothing new", () => {
    const db = openDb(":memory:");
    const versions = (db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as { version: number }[]).map(
      (r) => r.version,
    );
    expect(versions).toEqual([1, ...MIGRATIONS.map((m) => m.version)]);
    expect(runMigrations(db)).toEqual([]);
  });

  it("upgrades an old database without touching its rows", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // An old database: baseline tables only, with a row already stored.
    db.exec(`CREATE TABLE scans (id TEXT PRIMARY KEY, target TEXT NOT NULL, mode TEXT NOT NULL,
      status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, findings_count INTEGER NOT NULL DEFAULT 0)`);
    db.prepare(`INSERT INTO scans (id, target, mode, status, started_at) VALUES ('old', 'a.com', 'legacy', 'x', ?)`).run(now);
    initSchema(db);
    expect(db.prepare(`SELECT mode FROM scans WHERE id = 'old'`).get()).toEqual({ mode: "legacy" });
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'findings_scan_id'`).get();
    expect(idx).toBeTruthy();
  });

  it("blocks bad values at the database level", () => {
    const db = openDb(":memory:");
    const scan = db.prepare(`INSERT INTO scans (id, target, mode, status, started_at) VALUES (?, 'a.com', ?, ?, ?)`);
    expect(() => scan.run("s1", "loud", "running", now)).toThrow(/scans.mode/);
    expect(() => scan.run("s2", "passive", "weird", now)).toThrow(/scans.status/);
    scan.run("s3", "passive", "running", now);
    expect(() => db.prepare(`UPDATE scans SET status = 'done' WHERE id = 's3'`).run()).toThrow(/scans.status/);
    expect(() =>
      db
        .prepare(`INSERT INTO findings (scan_id, severity, code, title, detail, created_at) VALUES ('s3', 'urgent', 'c', 't', 'd', ?)`)
        .run(now),
    ).toThrow(/findings.severity/);
    const r = db.prepare(`INSERT INTO health_reports (host, created_at, text) VALUES ('a.com', ?, 'x')`).run(now);
    expect(() =>
      db
        .prepare(`INSERT INTO health_scores (report_id, host, area, label, score, evidence, created_at) VALUES (?, 'a.com', 'a', 'l', 101, 'e', ?)`)
        .run(r.lastInsertRowid, now),
    ).toThrow(/health_scores.score/);
    expect(() =>
      db.prepare(`INSERT INTO uptime_checks (host, ts, ok) VALUES ('a.com', ?, 2)`).run(now),
    ).toThrow(/uptime_checks.ok/);
  });
});
