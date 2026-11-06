import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadCompliance } from "../server/aeos/compliance.js";

const root = join(__dirname, "..");
const dataFile = join(root, "reports", "aeos-compliance.json");
const registerFile = join(root, "docs", "aeos-compliance-register.md");

describe("AEOS compliance register matches the collected data", () => {
  const report = loadCompliance(dataFile, new Date());
  const md = existsSync(registerFile) ? readFileSync(registerFile, "utf8") : "";

  it("the committed data file is a valid report (never presented as real-time)", () => {
    expect(["ok", "stale"]).toContain(report.status);
    expect(report.realtime).toBe(false);
    expect(report.apps?.length).toBe(5);
  });

  it("every app's name, score and pull request link appear in the register", () => {
    for (const a of report.apps ?? []) {
      expect(md).toContain(a.application);
      expect(md).toContain(`**${a.score}**`);
      if (a.pr) expect(md).toContain(a.pr.html_url);
    }
  });

  it("the register states the collection date of the data it was built from", () => {
    expect(md).toContain(report.collectedAt ?? "missing");
  });

  it("lists every unverified item recorded in the data, not fewer", () => {
    for (const a of report.apps ?? []) for (const item of a.unverified_items ?? []) expect(md).toContain(item);
  });
});
