import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// EEN-REL-001: Livio is the only human release approver. Instruction and release
// documents must not ask for a second human, account, collaborator or approving review.
const FORBIDDEN = [
  /second (human|github )?(account|approver|reviewer)/i,
  /add (a|another) collaborator/i,
  /(1|one|two) approving reviews?/i,
  /required reviewers?\s*=/i,
  /second human/i,
];
const ROOTS = ["CLAUDE.md", "AGENTS.md", "EENDIGO_AEOS.md", ".engineering", "docs", "eees/v1.0", "scripts/aeos/templates"];
const SKIP = ["docs/policies/EEN-REL-001.md"];

function files(p: string): string[] {
  try {
    if (statSync(p).isFile()) return /\.(md|json)$/.test(p) ? [p] : [];
    return readdirSync(p).flatMap((n) => files(join(p, n)));
  } catch { return []; }
}

describe("release policy EEN-REL-001", () => {
  it("the policy file exists and names Livio as the only approver", () => {
    expect(readFileSync("docs/policies/EEN-REL-001.md", "utf8")).toMatch(/only human release approver/);
  });
  it("no instruction or release document asks for a second approver", () => {
    const hits: string[] = [];
    for (const f of ROOTS.flatMap(files).filter((f) => !SKIP.includes(f))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        // A line that states the policy itself ("never require ...") is allowed.
        if (/never (require|ask|request)/i.test(line)) return;
        if (FORBIDDEN.some((r) => r.test(line))) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
