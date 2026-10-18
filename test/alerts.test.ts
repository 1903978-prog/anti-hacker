import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import {
  newFindings,
  sendAlerts,
  buildMessage,
  alertConfigFromEnv,
  type AlertConfig,
  type NewFinding,
  type Sender,
} from "../server/notify/alerts.js";
import { runWeeklySweep, type ScanFn } from "../server/schedule/weekly.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import type { Finding } from "../server/scan/types.js";

type Db = ReturnType<typeof freshDb>;

function storeScan(db: Db, id: string, host: string, finishedAt: string, findings: Finding[], status = "completed") {
  db.prepare(
    `INSERT INTO scans (id, target, mode, status, started_at, finished_at, findings_count)
     VALUES (?, ?, 'passive', ?, ?, ?, ?)`,
  ).run(id, host, status, finishedAt, finishedAt, findings.length);
  for (const f of findings) {
    db.prepare(
      `INSERT INTO findings (scan_id, severity, code, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, f.severity, f.code, f.title, f.detail, finishedAt);
  }
}

const f = (code: string, severity: Finding["severity"] = "medium"): Finding => ({
  severity,
  code,
  title: `title ${code}`,
  detail: `detail ${code}`,
});

const cfg: AlertConfig = { apiKey: "test-key", to: "me@example.com", from: "secval <a@example.com>" };

function auditActions(db: Db): string[] {
  return (db.prepare(`SELECT action FROM audit_log ORDER BY id`).all() as { action: string }[]).map((r) => r.action);
}

describe("new-finding detection", () => {
  it("treats every alert-worthy finding as new on a site's first scan", () => {
    const db = freshDb();
    storeScan(db, "s1", "a.com", "2026-10-19T06:00:00Z", [f("x"), f("y")]);
    const out = newFindings(db, { host: "a.com", scanId: "s1", findings: [f("x"), f("y")] });
    expect(out.map((o) => o.code)).toEqual(["x", "y"]);
  });

  it("reports only codes the previous scan of the same site did not have", () => {
    const db = freshDb();
    storeScan(db, "s1", "a.com", "2026-10-12T06:00:00Z", [f("x")]);
    storeScan(db, "other", "b.com", "2026-10-15T06:00:00Z", [f("y")]); // another site does not count
    storeScan(db, "s2", "a.com", "2026-10-19T06:00:00Z", [f("x"), f("y")]);
    const out = newFindings(db, { host: "a.com", scanId: "s2", findings: [f("x"), f("y")] });
    expect(out.map((o) => o.code)).toEqual(["y"]);
  });

  it("compares with the latest earlier COMPLETED scan, ignoring aborted ones", () => {
    const db = freshDb();
    storeScan(db, "s1", "a.com", "2026-10-05T06:00:00Z", [f("x")]);
    storeScan(db, "s2", "a.com", "2026-10-12T06:00:00Z", [], "aborted");
    storeScan(db, "s3", "a.com", "2026-10-19T06:00:00Z", [f("x")]);
    expect(newFindings(db, { host: "a.com", scanId: "s3", findings: [f("x")] })).toEqual([]);
  });

  it("never alerts on info-level findings", () => {
    const db = freshDb();
    const out = newFindings(db, { host: "a.com", scanId: null, findings: [f("i", "info"), f("h", "high")] });
    expect(out.map((o) => o.code)).toEqual(["h"]);
  });
});

describe("sending the alert", () => {
  const items: NewFinding[] = [
    { ...f("low1", "low"), host: "b.com" },
    { ...f("hi1", "high"), host: "a.com" },
  ];

  it("sends ONE message with every new finding, highest level first, and audits it", async () => {
    const db = freshDb();
    const sent: string[] = [];
    const sender: Sender = async (msg, key) => {
      expect(key).toBe("test-key");
      sent.push(msg.text);
    };
    expect(await sendAlerts(db, items, "scheduler", cfg, sender)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.indexOf("hi1")).toBeLessThan(sent[0]!.indexOf("low1"));
    expect(auditActions(db)).toContain("alert.sent");
  });

  it("sends nothing when there is nothing new", async () => {
    const db = freshDb();
    let calls = 0;
    expect(await sendAlerts(db, [], "scheduler", cfg, async () => void calls++)).toBe("none");
    expect(calls).toBe(0);
  });

  it("records 'not configured' instead of failing when no mail key is set", async () => {
    const db = freshDb();
    let calls = 0;
    const out = await sendAlerts(db, items, "scheduler", { ...cfg, apiKey: null }, async () => void calls++);
    expect(out).toBe("not_configured");
    expect(calls).toBe(0);
    expect(auditActions(db)).toContain("alert.skipped");
  });

  it("never throws when the provider fails; the failure is audited", async () => {
    const db = freshDb();
    const out = await sendAlerts(db, items, "scheduler", cfg, async () => {
      throw new Error("mail provider answered 500");
    });
    expect(out).toBe("failed");
    expect(auditActions(db)).toContain("alert.failed");
  });

  it("escapes finding text in the HTML body", () => {
    const msg = buildMessage([{ ...f("x"), title: "<script>", host: "a.com" }], cfg);
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
    expect(msg.subject).toBe("secval: 1 new security finding on 1 site");
  });

  it("reads its settings from the environment, with safe defaults", () => {
    expect(alertConfigFromEnv({}).apiKey).toBeNull();
    expect(alertConfigFromEnv({ RESEND_API_KEY: "  " }).apiKey).toBeNull();
    expect(alertConfigFromEnv({ RESEND_API_KEY: "k", ALERT_TO: "x@y.z" })).toMatchObject({ apiKey: "k", to: "x@y.z" });
  });
});

describe("weekly sweep sends alerts", () => {
  it("passes the new findings of all scanned sites to one alert call", async () => {
    const db = freshDb();
    const { token } = createChallenge(db, "eendigo.com", "op")!;
    await verifyOwnership(db, "eendigo.com", "dns-txt", "op", { resolveTxt: async () => [[token]] });

    const scan: ScanFn = async (_db, req) => ({
      scanId: "fake",
      status: "completed",
      host: req.target,
      findings: [f("x", "high"), f("i", "info")],
    });
    const calls: NewFinding[][] = [];
    const result = await runWeeklySweep(db, "scheduler", scan, async (_db, items) => {
      calls.push(items);
      return "sent";
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((i) => i.code)).toEqual(["x"]);
    expect(result).toMatchObject({ scanned: 1, newFindings: 1, alert: "sent" });
  });
});
