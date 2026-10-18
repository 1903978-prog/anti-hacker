import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../server/db.js";
import { freshDb } from "./helpers.js";
import { backupStatus, getLastDrill, runRestoreDrill } from "../server/backup/drill.js";
import { listAudit } from "../server/audit/log.js";

afterEach(() => {
  delete process.env.SECVAL_BACKUP_MODE;
});

describe("restore drill", () => {
  it("passes when the restored copy opens and is intact", async () => {
    const db = freshDb();
    const r = await runRestoreDrill(db, "test", async (out) => {
      const copy = openDb(out);
      copy.prepare(`INSERT INTO allowlist (domain, added_at) VALUES ('example.com', '2026-10-18')`).run();
      copy.close();
    });
    expect(r.detail).toBe("Backup restored and checked");
    expect(r.ok).toBe(true);
    expect(r.allowlistRows).toBeGreaterThanOrEqual(1);
    expect(getLastDrill(db)?.ok).toBe(true);
    expect(listAudit(db).some((a) => a.action === "backup.restore_drill")).toBe(true);
  });

  it("fails when the restore fails", async () => {
    const db = freshDb();
    const r = await runRestoreDrill(db, "test", async () => {
      throw new Error("bucket unreachable");
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("bucket unreachable");
  });

  it("fails when the restored file is not a secval store", async () => {
    const db = freshDb();
    const r = await runRestoreDrill(db, "test", async (out) => {
      new Database(out).close(); // empty database, no tables
    });
    expect(r.ok).toBe(false);
  });

  it("is healthy only when backing up and a recent drill passed", async () => {
    const db = freshDb();
    await runRestoreDrill(db, "test", async (out) => { openDb(out).close(); });
    expect(backupStatus(db).healthy).toBe(false); // mode off
    process.env.SECVAL_BACKUP_MODE = "on";
    expect(backupStatus(db).healthy).toBe(true);
    expect(backupStatus(db, new Date(Date.now() + 3 * 86_400_000)).healthy).toBe(false); // stale
  });
});
