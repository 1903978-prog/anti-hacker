import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { formatDate, formatDateTimeUtc } from "../server/util/dates.js";

// public/dates.js is a plain browser script; run it the way the browser does.
const ctx: { fd?: (v: unknown, tz?: string) => string; fdt?: (v: unknown, tz?: string) => string } = {};
vm.runInNewContext(readFileSync("public/dates.js", "utf8") + "\nthis.fd = formatDate; this.fdt = formatDateTime;", ctx);

describe("dates are shown as 03 Nov 2026", () => {
  it("browser helper", () => {
    expect(ctx.fd!("2026-11-03")).toBe("03 Nov 2026");
    expect(ctx.fd!("2026-09-05T10:00:00Z", "Europe/Paris")).toBe("05 Sep 2026");
    expect(ctx.fdt!("2026-11-03T13:05:00Z", "Europe/Paris")).toBe("03 Nov 2026, 14:05");
    expect(ctx.fd!(null)).toBe("");
    expect(ctx.fd!("not a date")).toBe("");
  });
  it("server helper", () => {
    expect(formatDate("2026-11-03T23:59:00Z")).toBe("03 Nov 2026");
    expect(formatDateTimeUtc("2026-11-03T14:05:00Z")).toBe("03 Nov 2026, 14:05 UTC");
    expect(formatDate(undefined)).toBe("");
  });
});
