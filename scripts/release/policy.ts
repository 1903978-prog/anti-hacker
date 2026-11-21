/**
 * Standing release delegation (SECVAL-SRD-001): the policy file and the
 * change classifier. Pure functions only, so every boundary is unit-tested.
 *
 * Tiers: GREEN merges and deploys on its own once every check passes; AMBER
 * needs the extra controls in the policy; RED is never released by the
 * machine and goes to Livio. Anything the policy does not name is RED
 * (fail closed).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const POLICY_PATH = ".github/release-policy.json";

const ContentRule = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1),
  why: z.string().min(1),
  skip_paths: z.array(z.string()).default([]),
});

export const PolicySchema = z.object({
  policy_id: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["inactive", "active", "revoked"]),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  target_branch: z.string().min(1),
  production_url: z.string().url().startsWith("https://"),
  required_checks: z.array(z.string().min(1)).min(1),
  review_marker: z.string().regex(/^[a-z0-9-]+$/),
  trusted_logins: z.array(z.string().min(1)).min(1),
  stop_labels: z.array(z.string().min(1)).min(1),
  pause_variable: z.string().regex(/^[A-Z0-9_]+$/),
  limits: z.object({
    max_changed_files: z.number().int().positive(),
    max_changed_lines: z.number().int().positive(),
    amber_max_changed_lines: z.number().int().positive(),
  }),
  verify: z.object({ timeout_minutes: z.number().positive(), poll_seconds: z.number().positive() }),
  red_paths: z.array(z.string().min(1)).min(1),
  amber_paths: z.array(z.string().min(1)),
  green_paths: z.array(z.string().min(1)),
  red_content: z.array(ContentRule),
  red_removed: z.array(ContentRule).min(1),
  amber_content: z.array(ContentRule),
}).passthrough();

export type Policy = z.infer<typeof PolicySchema>;
export type Tier = "GREEN" | "AMBER" | "RED";

/** Parses the policy; any problem throws, and callers treat a throw as "do not release". */
export function parsePolicy(text: string): Policy {
  return PolicySchema.parse(JSON.parse(text));
}

export function loadPolicy(path = POLICY_PATH): Policy {
  return parsePolicy(readFileSync(path, "utf8"));
}

/** Glob to RegExp: `**` any depth, `*` within one path segment. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else re += /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (path: string, globs: string[]): boolean => globs.some((g) => globToRegExp(g).test(path));

export interface ChangedFile {
  filename: string;
  /** "added" | "modified" | "removed" | "renamed" ... as GitHub reports it. */
  status: string;
  previous_filename?: string;
  additions: number;
  deletions: number;
  /** Unified diff; GitHub omits it for very large or binary files. */
  patch?: string;
}

export interface Classification {
  tier: Tier;
  reasons: string[];
  files: { path: string; tier: Tier }[];
  touchesData: boolean;
  testsChanged: boolean;
  changedLines: number;
}

const rank: Record<Tier, number> = { GREEN: 0, AMBER: 1, RED: 2 };
const worst = (a: Tier, b: Tier): Tier => (rank[a] >= rank[b] ? a : b);

function pathTier(p: Policy, path: string): Tier {
  if (matchesAny(path, p.red_paths)) return "RED";
  if (matchesAny(path, p.amber_paths)) return "AMBER";
  if (matchesAny(path, p.green_paths)) return "GREEN";
  return "RED";
}

/** Splits a GitHub per-file patch into hunks that contain at least one changed line. */
function hunks(patch: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) { out.push(cur); cur = []; } else cur.push(l);
  }
  out.push(cur);
  return out.filter((h) => h.some((l) => l.startsWith("+") || l.startsWith("-")));
}

const DATA_PATHS = ["server/migrations.ts", "server/db.ts", "server/backup/**"];

/** Classifies a PR's change set. Unknown paths, missing diffs, deleted tests and red content are RED. */
export function classify(p: Policy, files: ChangedFile[]): Classification {
  const reasons: string[] = [];
  let tier: Tier = "GREEN";
  const out: { path: string; tier: Tier }[] = [];
  if (files.length === 0) {
    return { tier: "RED", reasons: ["no changed files reported (fail closed)"], files: [], touchesData: false, testsChanged: false, changedLines: 0 };
  }
  const compile = (rs: Policy["red_content"]) => rs.map((r) => ({ ...r, re: new RegExp(r.pattern, "i") }));
  const red = compile(p.red_content), removedRules = compile(p.red_removed), amber = compile(p.amber_content);
  for (const f of files) {
    const paths = [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])];
    let t: Tier = paths.map((x) => pathTier(p, x)).reduce(worst, "GREEN" as Tier);
    if (t !== "GREEN") reasons.push(`${f.filename}: ${t} path`);
    if (f.status === "removed" && f.filename.startsWith("test/")) {
      t = "RED";
      reasons.push(`${f.filename}: deletes a test`);
    }
    // GitHub's per-file patch has no ---/+++ headers, so every "+"/"-" line is content.
    // No patch (binary, submodule, too large) means the change cannot be checked.
    if (typeof f.patch !== "string" || (f.patch === "" && f.status !== "removed" && f.additions + f.deletions > 0)) {
      t = "RED";
      reasons.push(`${f.filename}: diff not available, cannot be checked`);
    }
    const lines = (f.patch ?? "").split("\n");
    const added = lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    const hit = (rs: typeof red, ls: string[], tier: Tier, what: string) => {
      for (const r of rs) {
        if (matchesAny(f.filename, r.skip_paths)) continue;
        if (ls.some((l) => r.re.test(l))) {
          t = worst(t, tier);
          reasons.push(`${f.filename}: ${r.id} (${r.why}) in ${what} lines`);
        }
      }
    };
    hit(red, added, "RED", "added");
    // Safety rules look at each changed hunk with its context lines, so replacing the body of
    // `if (isEngaged(db)) { ... }` without touching the `if` line is still caught.
    for (const h of hunks(f.patch ?? "")) {
      for (const r of removedRules) {
        if (matchesAny(f.filename, r.skip_paths)) continue;
        if (h.some((l) => r.re.test(l.slice(1)))) {
          t = "RED";
          reasons.push(`${f.filename}: ${r.id} (${r.why})`);
          break;
        }
      }
    }
    hit(amber, added, "AMBER", "added");
    out.push({ path: f.filename, tier: t });
    tier = worst(tier, t);
  }
  const changedLines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (files.length > p.limits.max_changed_files) {
    tier = "RED";
    reasons.push(`${files.length} files changed, over the ${p.limits.max_changed_files} limit`);
  }
  if (changedLines > p.limits.max_changed_lines) {
    tier = "RED";
    reasons.push(`${changedLines} lines changed, over the ${p.limits.max_changed_lines} limit`);
  }
  return {
    tier,
    reasons,
    files: out,
    touchesData: files.some((f) => matchesAny(f.filename, DATA_PATHS)),
    testsChanged: files.some((f) => f.filename.startsWith("test/") && f.status !== "removed"),
    changedLines,
  };
}
