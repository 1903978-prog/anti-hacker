import type { DB } from "./db.js";
import { MIGRATIONS } from "./migrations.js";

/**
 * Store integrity check. Runs SQLite's own checks on the live store: the file
 * is not corrupt (integrity_check), every link between records points at a
 * row that exists (foreign_key_check), the audit trail's append-only guards
 * are in place, and every schema migration has been applied. It only reads.
 * The result is kept in memory and shown (as yes/no plus counts, never data)
 * on the public /health endpoint.
 */
export interface IntegrityResult {
  ok: boolean;
  at: string; // ISO time of the check
  /** "ok", or the first problems SQLite reported. */
  integrity: string[];
  /** Number of records whose link points at a missing row. */
  brokenLinks: number;
  /** Highest applied schema version, and the version the code expects. */
  schemaVersion: number;
  expectedSchemaVersion: number;
  /** The audit trail's append-only triggers are present. */
  auditGuarded: boolean;
}

export function checkIntegrity(db: DB, now: Date = new Date()): IntegrityResult {
  let integrity: string[];
  try {
    integrity = (db.pragma("integrity_check") as Array<{ integrity_check: string }>)
      .map((r) => r.integrity_check)
      .slice(0, 5);
  } catch (err) {
    integrity = [`integrity_check failed: ${(err as Error).message}`];
  }
  let brokenLinks: number;
  try {
    brokenLinks = (db.pragma("foreign_key_check") as unknown[]).length;
  } catch {
    brokenLinks = -1; // could not check: counts as a problem
  }
  const schemaVersion =
    (db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get() as { v: number | null }).v ?? 0;
  const expectedSchemaVersion = Math.max(1, ...MIGRATIONS.map((m) => m.version));
  const triggers = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log'`)
    .all() as Array<{ name: string }>;
  const names = new Set(triggers.map((t) => t.name));
  const auditGuarded = names.has("audit_log_no_update") && names.has("audit_log_no_delete");

  const ok =
    integrity.length === 1 &&
    integrity[0] === "ok" &&
    brokenLinks === 0 &&
    schemaVersion >= expectedSchemaVersion &&
    auditGuarded;
  return {
    ok,
    at: now.toISOString(),
    integrity,
    brokenLinks,
    schemaVersion,
    expectedSchemaVersion,
    auditGuarded,
  };
}

const latest = new WeakMap<DB, IntegrityResult>();

/** Runs the check and remembers the result for /health. */
export function refreshIntegrity(db: DB): IntegrityResult {
  const r = checkIntegrity(db);
  latest.set(db, r);
  return r;
}

/** The last result, running the check first if there is none yet. */
export function lastIntegrity(db: DB): IntegrityResult {
  return latest.get(db) ?? refreshIntegrity(db);
}

/** Re-checks once a day (the first check runs when the server starts). */
export function startIntegrityWatch(db: DB, everyMs = 24 * 60 * 60_000): () => void {
  const run = () => {
    try {
      const r = refreshIntegrity(db);
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.error("secval: store integrity check FAILED", JSON.stringify(r));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("secval: store integrity check could not run", (err as Error).message);
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
