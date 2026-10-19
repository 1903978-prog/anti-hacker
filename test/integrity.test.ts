import { describe, it, expect } from "vitest";
import request from "supertest";
import { freshDb } from "./helpers.js";
import { checkIntegrity, refreshIntegrity } from "../server/integrity.js";
import { createApp } from "../server/app.js";
import { MIGRATIONS } from "../server/migrations.js";

describe("store integrity check", () => {
  it("passes on a fresh store", () => {
    const r = checkIntegrity(freshDb());
    expect(r).toMatchObject({ ok: true, integrity: ["ok"], brokenLinks: 0, auditGuarded: true });
    expect(r.schemaVersion).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
  });

  it("flags a record whose link points at a missing row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF"); // simulate an old or damaged store
    db.prepare(
      `INSERT INTO findings (scan_id, severity, code, title, detail, created_at) VALUES ('nope', 'low', 'c', 't', 'd', 'x')`,
    ).run();
    db.pragma("foreign_keys = ON");
    const r = checkIntegrity(db);
    expect(r.ok).toBe(false);
    expect(r.brokenLinks).toBe(1);
  });

  it("flags a missing audit-trail guard", () => {
    const db = freshDb();
    db.exec(`DROP TRIGGER audit_log_no_delete`);
    expect(checkIntegrity(db)).toMatchObject({ ok: false, auditGuarded: false });
  });

  it("flags a store missing schema migrations", () => {
    const db = freshDb();
    db.exec(`DELETE FROM schema_migrations WHERE version > 1`);
    expect(checkIntegrity(db)).toMatchObject({ ok: false, schemaVersion: 1 });
  });

  it("is reported on /health and /health/store without a token", async () => {
    const db = freshDb();
    const app = createApp(db, { apiToken: "t" });
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.store).toMatchObject({ ok: true, brokenLinks: 0 });

    expect((await request(app).get("/health/store")).status).toBe(200);
    db.exec(`DROP TRIGGER audit_log_no_update`);
    refreshIntegrity(db); // the endpoint re-checks at most once a minute
    const bad = await request(app).get("/health/store");
    expect(bad.status).toBe(503);
    expect(bad.body.auditGuarded).toBe(false);
  });
});
