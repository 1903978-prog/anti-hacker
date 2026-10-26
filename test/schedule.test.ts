import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { isWeeklyDue, tick, runWeeklySweep, getLastRun, type ScanFn } from "../server/schedule/weekly.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";

async function prove(db: ReturnType<typeof freshDb>, domain: string) {
  const { token } = createChallenge(db, domain, "op")!;
  await verifyOwnership(db, domain, "dns-txt", "op", { resolveTxt: async () => [[token]] });
}

// A fake scanner so the sweep never touches the network in tests.
const fakeScan: ScanFn = async (_db, req) => ({
  scanId: "fake",
  status: "completed",
  host: req.target,
  findings: [{ severity: "low", code: "x", title: "t", detail: "d" }],
});

// Monday 2026-10-19 08:30 Europe/Paris == 06:30 UTC (CEST, +2).
const mondayMorningUtc = new Date("2026-10-19T06:30:00Z");
// Sunday, and Monday before 8am.
const sundayUtc = new Date("2026-10-18T10:00:00Z");
const mondayEarlyUtc = new Date("2026-10-19T05:00:00Z"); // 07:00 Paris

describe("weekly due check", () => {
  it("is due on Monday at/after the configured local hour", () => {
    expect(isWeeklyDue(mondayMorningUtc, null).due).toBe(true);
  });
  it("is not due on other days", () => {
    expect(isWeeklyDue(sundayUtc, null).due).toBe(false);
  });
  it("is not due before the configured hour", () => {
    expect(isWeeklyDue(mondayEarlyUtc, null).due).toBe(false);
  });
  it("does not re-fire once the week's slot has run", () => {
    const { key } = isWeeklyDue(mondayMorningUtc, null);
    expect(isWeeklyDue(mondayMorningUtc, key).due).toBe(false);
  });
  it("catches up a missed week after the server wakes (any day)", () => {
    // Last run Monday 12 Oct; the server slept through Monday 19 Oct 08:00 and
    // wakes on Wednesday 21 Oct: the missed sweep is due, keyed to the 19th.
    const wednesday = new Date("2026-10-21T13:00:00Z");
    expect(isWeeklyDue(wednesday, "2026-10-12")).toEqual({ due: true, key: "2026-10-19" });
    // Once that catch-up has run, it does not fire again that week.
    expect(isWeeklyDue(wednesday, "2026-10-19").due).toBe(false);
  });
  it("does not catch up before the week's slot has come", () => {
    // Sunday 18 Oct: the latest slot is Monday 12 Oct, already run.
    expect(isWeeklyDue(sundayUtc, "2026-10-12").due).toBe(false);
    // Monday 07:00 Paris: the slot for the 19th has not started yet.
    expect(isWeeklyDue(mondayEarlyUtc, "2026-10-12").due).toBe(false);
  });
});

describe("scheduler tick + sweep", () => {
  it("runs the sweep once when due and records the slot", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    const first = await tick(db, mondayMorningUtc, undefined, fakeScan);
    expect(first).not.toBeNull();
    expect(first!.scanned).toBe(1);
    expect(getLastRun(db)).toBe("2026-10-19");

    // A second tick the same morning must not run again.
    const second = await tick(db, mondayMorningUtc, undefined, fakeScan);
    expect(second).toBeNull();
  });

  it("scans only proven targets and reports the rest as skipped", async () => {
    const db = freshDb();
    await prove(db, "eendigo.com");
    const result = await runWeeklySweep(db, "scheduler", fakeScan);
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(4); // 5 seeds - 1 proven
  });
});
