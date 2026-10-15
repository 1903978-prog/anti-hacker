import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { appendAudit, listAudit } from "../server/audit/log.js";

describe("audit trail", () => {
  it("appends and lists entries newest-first", () => {
    const db = freshDb();
    appendAudit(db, { actor: "op", action: "a.one", decision: "info" });
    appendAudit(db, { actor: "op", action: "a.two", decision: "allow", target: "x.com" });
    const rows = listAudit(db);
    expect(rows[0]?.action).toBe("a.two");
    expect(rows[1]?.action).toBe("a.one");
  });

  it("is append-only: updates are rejected", () => {
    const db = freshDb();
    const id = appendAudit(db, { actor: "op", action: "a.one", decision: "info" });
    expect(() =>
      db.prepare(`UPDATE audit_log SET reason = 'tampered' WHERE id = ?`).run(id),
    ).toThrow(/append-only/);
  });

  it("is append-only: deletes are rejected", () => {
    const db = freshDb();
    const id = appendAudit(db, { actor: "op", action: "a.one", decision: "info" });
    expect(() => db.prepare(`DELETE FROM audit_log WHERE id = ?`).run(id)).toThrow(/append-only/);
  });

  it("stores structured detail", () => {
    const db = freshDb();
    appendAudit(db, { actor: "op", action: "a.detail", decision: "info", detail: { n: 42 } });
    expect(listAudit(db)[0]?.detail).toEqual({ n: 42 });
  });
});
