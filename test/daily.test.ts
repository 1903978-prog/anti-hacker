import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { buildDigest, digestTick } from "../server/notify/daily.js";
import type { AlertMessage } from "../server/notify/alerts.js";

const cfg = { apiKey: "k", to: "me@example.com", from: "secval <x@example.com>" };
const now = new Date("2026-10-28T07:30:00Z");

describe("daily digest", () => {
  it("says what needs attention and 'not measured' where unknown", () => {
    const db = freshDb();
    const ci = (h: string) =>
      h === "10bonds.com"
        ? { repo: "10bonds", branch: "main", checkedAt: "", failing: [{ name: "Deploy", url: "https://x/1", at: "" }],
            latest: { name: "Deploy", conclusion: "failure", at: "2026-10-28T05:00:00Z", url: "https://x/1" } }
        : null;
    const d = buildDigest(db, { now, ci, usageLines: ["- minutes: 12"], cfg });
    expect(d.needsAttention).toBe(1);
    expect(d.subject).toContain("1 thing needs you");
    expect(d.text).toContain("10bonds.com: Deploy is failing, https://x/1");
    expect(d.text).toContain("Nightly live check: not measured");
    expect(d.text).toContain("Live: not measured");
  });

  it("sends once a day, only from 07:00 UTC, and records a missing key", async () => {
    const db = freshDb();
    const sent: AlertMessage[] = [];
    const send = async (m: AlertMessage) => void sent.push(m);
    process.env.RESEND_API_KEY = "k";
    expect(await digestTick(db, new Date("2026-10-28T06:00:00Z"), send)).toBe("not_due");
    expect(await digestTick(db, now, send)).toBe("sent");
    expect(await digestTick(db, new Date("2026-10-28T09:00:00Z"), send)).toBe("not_due");
    expect(sent).toHaveLength(1);
    expect(await digestTick(db, new Date("2026-10-29T07:00:00Z"), send)).toBe("sent");
    delete process.env.RESEND_API_KEY;
    expect(await digestTick(db, new Date("2026-10-30T07:00:00Z"), send)).toBe("not_configured");
  });
});
