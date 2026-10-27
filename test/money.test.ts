import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// public/money.js is a plain browser script; run it the way the browser does.
const ctx: { isBigCost?: (n: number) => boolean } = {};
vm.runInNewContext(readFileSync("public/money.js", "utf8") + "\nthis.isBigCost = isBigCost;", ctx);
const isBigCost = ctx.isBigCost!;

describe("red oval threshold", () => {
  it("marks costs above $2 only", () => {
    expect(isBigCost(8.23)).toBe(true);
    expect(isBigCost(2.01)).toBe(true);
    expect(isBigCost(2)).toBe(false);
    expect(isBigCost(0)).toBe(false);
  });
});
