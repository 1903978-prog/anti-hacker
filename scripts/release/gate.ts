/**
 * The release gate: decides, from evidence only, whether one PR may be
 * merged and deployed by the machine. Every missing or unreadable input
 * fails closed. Pure function: the GitHub calls live in run.ts.
 */
import { classify, type ChangedFile, type Classification, type Policy } from "./policy.js";

export interface CheckRun { name: string; status: string; conclusion: string | null; head_sha: string }
export interface Comment { body: string; login: string; association: string; created_at: string }
export interface PullInfo {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  base: string;
  baseRepo: string;
  headRepo: string;
  headSha: string;
  author: string;
  mergeable: boolean | null;
  mergeableState: string;
  body: string;
}
export interface GateInput {
  policy: Policy;
  /** Value of the repo variable named policy.pause_variable ("" when unset). */
  pauseVariable: string | undefined;
  /** Open issues carrying a stop label; null when the lookup failed. */
  stopIssues: number[] | null;
  pr: PullInfo;
  /** Commits integration has that the PR head lacks; null when unknown. */
  behindBy: number | null;
  checks: CheckRun[] | null;
  comments: Comment[] | null;
  files: ChangedFile[] | null;
  /** Production backup facts, needed only for AMBER data changes; null when unreadable. */
  production: { backupMode: string; lastDrillOk: boolean | null } | null;
}

export type Outcome = "release" | "would-release" | "wait" | "refuse" | "owner";
export interface Decision {
  outcome: Outcome;
  tier: Classification["tier"] | null;
  sha: string;
  reasons: string[];
  review: ReviewMarker | null;
  classification: Classification | null;
}

export interface ReviewMarker { verdict: "PASS" | "FAIL"; sha: string; reviewer: string; impact: string; rollback: string }

const SHA = /^[0-9a-f]{40}$/;

/** Reads `<!-- <marker> verdict=PASS sha=<40 hex> reviewer=<id> [impact=assessed] [rollback=ok] -->`. */
export function parseMarkers(marker: string, body: string): ReviewMarker[] {
  const out: ReviewMarker[] = [];
  const re = new RegExp(`<!--\\s*${marker}\\s+([^>]*?)\\s*-->`, "g");
  for (const m of body.matchAll(re)) {
    const kv = Object.fromEntries((m[1] ?? "").split(/\s+/).map((p) => p.split("=", 2) as [string, string]));
    if ((kv.verdict === "PASS" || kv.verdict === "FAIL") && SHA.test(kv.sha ?? "") && kv.reviewer) {
      out.push({ verdict: kv.verdict, sha: kv.sha!, reviewer: kv.reviewer, impact: kv.impact ?? "", rollback: kv.rollback ?? "" });
    }
  }
  return out;
}

export const authorSession = (body: string): string | null => /^Author-Session:\s*(\S+)\s*$/m.exec(body)?.[1] ?? null;

export function decide(i: GateInput): Decision {
  const p = i.policy;
  const sha = i.pr.headSha;
  const base = { tier: null, sha, review: null, classification: null } as const;
  const refuse = (...reasons: string[]): Decision => ({ ...base, outcome: "refuse", reasons });
  const wait = (...reasons: string[]): Decision => ({ ...base, outcome: "wait", reasons });

  // 1. Owner controls first: revoked, paused or an open stop/incident issue stops everything.
  if (p.status === "revoked") return refuse("standing delegation is revoked");
  if ((i.pauseVariable ?? "").trim().toLowerCase() === "off") return refuse(`paused by the owner (${p.pause_variable}=off)`);
  if (i.stopIssues === null) return refuse("could not read stop issues (fail closed)");
  if (i.stopIssues.length > 0) return refuse(`paused: open stop/incident issue #${i.stopIssues.join(", #")}`);

  // 2. Right repository, branch and PR state.
  if (i.pr.baseRepo !== p.repository) return refuse(`wrong repository ${i.pr.baseRepo}`);
  if (i.pr.headRepo !== p.repository) return refuse("PR comes from a fork");
  if (i.pr.base !== p.target_branch) return refuse(`base is ${i.pr.base}, not ${p.target_branch}`);
  if (i.pr.state !== "open" || i.pr.merged) return refuse("PR is not open");
  if (!p.trusted_logins.includes(i.pr.author)) return refuse(`PR author ${i.pr.author} is not trusted`);
  if (!SHA.test(sha)) return refuse("head SHA unreadable");
  if (i.pr.draft) return wait("PR is a draft");

  // 3. Change classification.
  if (i.files === null) return refuse("could not read changed files (fail closed)");
  const c = classify(p, i.files);
  if (c.tier === "RED") return { ...base, outcome: "owner", tier: "RED", classification: c, reasons: ["RED change: needs Livio's own approval", ...c.reasons] };

  // 4. CI on this exact SHA.
  if (i.checks === null) return refuse("could not read checks (fail closed)");
  const onSha = i.checks.filter((r) => r.head_sha === sha);
  const bad = onSha.filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion ?? ""));
  if (bad.length) return { ...refuse(...bad.map((r) => `check ${r.name} is ${r.conclusion}`)), tier: c.tier, classification: c };
  for (const name of p.required_checks) {
    const runs = onSha.filter((r) => r.name === name);
    if (!runs.length || runs.some((r) => r.status !== "completed")) return wait(`required check ${name} has not finished on ${sha.slice(0, 12)}`);
    if (!runs.every((r) => r.conclusion === "success")) return refuse(`required check ${name} did not pass`);
  }

  // 5. Independent AI review bound to this SHA, from a trusted commenter, by a different session.
  if (i.comments === null) return refuse("could not read comments (fail closed)");
  const markers = i.comments
    .filter((m) => p.trusted_logins.includes(m.login) && m.association === "OWNER")
    .flatMap((m) => parseMarkers(p.review_marker, m.body));
  const forSha = markers.filter((m) => m.sha === sha);
  if (forSha.some((m) => m.verdict === "FAIL")) return { ...refuse("independent review FAILED on this SHA"), tier: c.tier, classification: c };
  const pass = forSha.find((m) => m.verdict === "PASS") ?? null;
  if (!pass) return wait(markers.length ? "review is for an older SHA; new review needed" : "no independent review yet");
  const author = authorSession(i.pr.body);
  if (!author) return { ...refuse("PR body has no Author-Session line, so review independence cannot be proven"), tier: c.tier, classification: c };
  if (author === pass.reviewer) return { ...refuse("reviewer is the same session that wrote the change"), tier: c.tier, classification: c };

  // 6. Up to date with the target branch and mergeable, so what was tested is what ships.
  if (i.behindBy === null) return refuse("could not compare with the target branch (fail closed)");
  if (i.behindBy > 0) return wait(`PR is ${i.behindBy} commit(s) behind ${p.target_branch}; update the branch`);
  if (i.pr.mergeable === null) return wait("GitHub is still computing mergeability");
  if (!i.pr.mergeable || !["clean", "unstable", "has_hooks"].includes(i.pr.mergeableState)) return refuse(`not mergeable (${i.pr.mergeableState})`);

  // 7. AMBER extra controls.
  const reasons: string[] = [...c.reasons];
  if (c.tier === "AMBER") {
    const miss: string[] = [];
    if (!c.testsChanged) miss.push("no test changed with an AMBER change");
    if (pass.impact !== "assessed") miss.push("review has no impact=assessed");
    if (pass.rollback !== "ok") miss.push("review has no rollback=ok");
    if (c.changedLines > p.limits.amber_max_changed_lines) miss.push(`AMBER change is ${c.changedLines} lines, over ${p.limits.amber_max_changed_lines}`);
    if (c.touchesData) {
      if (!i.production) miss.push("production backup state unreadable");
      else {
        if (i.production.backupMode !== "on") miss.push(`production backup mode is ${i.production.backupMode}, not on`);
        if (i.production.lastDrillOk !== true) miss.push("last restore drill did not pass");
      }
    }
    if (miss.length) return { ...base, outcome: "owner", tier: "AMBER", classification: c, review: pass, reasons: ["AMBER controls not met: needs Livio's approval", ...miss] };
    reasons.push("AMBER controls met");
  }

  const outcome: Outcome = p.status === "active" ? "release" : "would-release";
  return { ...base, outcome, tier: c.tier, classification: c, review: pass, reasons: [...reasons, "all release checks passed"] };
}
