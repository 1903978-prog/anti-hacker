import { describe, expect, it } from "vitest";
import { lastScheduledSlot, requiredSlot } from "../server/backup/schedule.js";
import { dueNow, type SecondCopyRun } from "../server/backup/secondCopy.js";

const iso = (d: Date) => d.toISOString();
const run = (at: string, ok = true): SecondCopyRun => ({ ok, at, day: at.slice(0, 10), detail: "x", copies: [], retention: { removed: [], detail: "" } }) as unknown as SecondCopyRun;

describe("weekly backup schedule (Monday 08:00 Bangkok = Monday 01:00 UTC)", () => {
  it("finds the latest Monday 01:00 UTC slot", () => {
    expect(iso(lastScheduledSlot(new Date("2026-11-23T01:00:00Z")))).toBe("2026-11-23T01:00:00.000Z");
    expect(iso(lastScheduledSlot(new Date("2026-11-23T00:59:00Z")))).toBe("2026-11-16T01:00:00.000Z");
    expect(iso(lastScheduledSlot(new Date("2026-11-21T09:00:00Z")))).toBe("2026-11-16T01:00:00.000Z");
  });
  it("requires the new slot only after 12 hours of grace", () => {
    expect(iso(requiredSlot(new Date("2026-11-23T12:59:00Z")))).toBe("2026-11-16T01:00:00.000Z");
    expect(iso(requiredSlot(new Date("2026-11-23T13:00:00Z")))).toBe("2026-11-23T01:00:00.000Z");
  });
  it("is due once per slot: a good run since the slot means nothing is due, a retry never makes a second generation", () => {
    const now = new Date("2026-11-23T07:00:00Z");
    expect(dueNow(null, now)).toBe(true);
    expect(dueNow(run("2026-11-23T01:05:00Z"), now)).toBe(false);
    expect(dueNow(run("2026-11-16T01:05:00Z"), now)).toBe(true);
    // a good run on Wednesday of the week still covers Thursday and Friday
    expect(dueNow(run("2026-11-25T09:00:00Z"), new Date("2026-11-27T09:00:00Z"))).toBe(false);
    // a failed run is retried only after 3 hours
    expect(dueNow(run("2026-11-23T06:00:00Z", false), now)).toBe(false);
    expect(dueNow(run("2026-11-23T03:00:00Z", false), now)).toBe(true);
  });
});
