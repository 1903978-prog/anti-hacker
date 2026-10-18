import { describe, it, expect } from "vitest";
import { performanceScore, reliabilityScore, providerFromDomain } from "../server/health/score.js";
import type { UptimeCheck } from "../server/health/uptime.js";

const check = (ok: boolean, ms: number | null, ts = "2026-10-18T10:00:00Z", status: number | null = ok ? 200 : 503): UptimeCheck =>
  ({ host: "app.example", ts, ok, status, ms, error: ok ? null : "timeout", provider: null });

describe("reliability score: share of checks the home page answered", () => {
  it("3 of 4 answered = 75", () => {
    const s = reliabilityScore([check(true, 100), check(false, null), check(true, 200), check(true, 300, "2026-10-18T11:00:00Z")])!;
    expect(s.score).toBe(75);
    expect(s.at).toBe("2026-10-18T11:00:00Z");
    expect(s.evidence[0]).toContain("3 of 4");
    expect(s.evidence[1]).toContain("OK");
  });
  it("a failed last check says so", () => {
    const s = reliabilityScore([check(true, 100), check(false, null)])!;
    expect(s.score).toBe(50);
    expect(s.evidence[1]).toContain("FAILED (status 503)");
  });
});

describe("performance score: typical answer time over 7 days", () => {
  it("bands at 0.5 s, 1 s, 1.5 s, 3 s", () => {
    expect(performanceScore([check(true, 500)])!.score).toBe(100);
    expect(performanceScore([check(true, 501)])!.score).toBe(90);
    expect(performanceScore([check(true, 1000)])!.score).toBe(90);
    expect(performanceScore([check(true, 1500)])!.score).toBe(80);
    expect(performanceScore([check(true, 3000)])!.score).toBe(65);
    expect(performanceScore([check(true, 3001)])!.score).toBe(40);
  });
  it("uses the median of answered checks only", () => {
    const s = performanceScore([check(true, 200), check(true, 2000), check(true, 400), check(false, null), check(true, 9000)])!;
    // answered times sorted 200, 400, 2000, 9000 -> median index 2 = 2000 ms -> 65
    expect(s.score).toBe(65);
    expect(s.evidence[0]).toContain("2000 ms over 4 checks");
  });
  it("no answered check = no score", () => {
    expect(performanceScore([check(false, null)])).toBeNull();
  });
});

describe("hosting provider from the address", () => {
  it("known hosts", () => {
    expect(providerFromDomain("secval.onrender.com")).toBe("Render");
    expect(providerFromDomain("lm-op-model.fly.dev")).toBe("Fly.io");
    expect(providerFromDomain("x.vercel.app")).toBe("Vercel");
    expect(providerFromDomain("x.netlify.app")).toBe("Netlify");
    expect(providerFromDomain("x.github.io")).toBe("GitHub Pages");
  });
  it("anything else is unknown", () => {
    expect(providerFromDomain("eendigo.com")).toBeNull();
    expect(providerFromDomain("fly.dev.example.com")).toBeNull();
  });
});
