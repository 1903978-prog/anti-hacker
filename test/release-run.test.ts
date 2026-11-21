import { describe, expect, it } from "vitest";
import { loadPolicy, type Policy } from "../scripts/release/policy.js";
import { runAudit, runGate, type Gh, type RunDeps } from "../scripts/release/run.js";
import { verifyDeploy, type VerifyDeps } from "../scripts/release/verify.js";
import type { Comment } from "../scripts/release/gate.js";

// Dry-run of the whole release mechanism against a fake GitHub and a fake
// production: merge, deploy verification, failed deploy, rollback, audit.

const real = loadPolicy();
const SHA = "c".repeat(40);
const MERGE = "d".repeat(40);
const REVERT = "e".repeat(40);
const policy = (status: Policy["status"]): Policy => ({ ...real, status, verify: { timeout_minutes: 1, poll_seconds: 10 } });

function fakeGh(o: { files?: string[]; revertFails?: boolean; comments?: Comment[] } = {}) {
  const calls: string[] = [];
  const posted: string[] = [];
  const comments: Comment[] = o.comments ?? [{ body: `<!-- secval-ai-review verdict=PASS sha=${SHA} reviewer=session_rev -->`, login: "1903978-prog", association: "OWNER", created_at: "t" }];
  const gh: Gh = {
    pull: async (n) => ({ number: n, state: "open", draft: false, merged: false, base: "integration", baseRepo: real.repository, headRepo: real.repository, headSha: SHA, author: "1903978-prog", mergeable: true, mergeableState: "clean", body: "Author-Session: session_dev" }),
    files: async () => (o.files ?? ["public/app.js"]).map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0, patch: "+x" })),
    checks: async (sha) => [{ name: "check", status: "completed", conclusion: "success", head_sha: sha }],
    comments: async () => [...comments, ...posted.map((body) => ({ body, login: "github-actions[bot]", association: "NONE", created_at: "t" }))],
    behindBy: async () => 0,
    stopIssues: async () => [],
    production: async () => ({ backupMode: "on", lastDrillOk: true }),
    merge: async (n, sha, _t, msg) => { calls.push(`merge ${n} ${sha} ${msg.includes("Auto-Release: SECVAL-SRD-001") ? "trailer" : ""}`); return MERGE; },
    dispatchCi: async (ref) => { calls.push(`ci ${ref}`); },
    comment: async (_n, body) => { posted.push(body); },
    label: async (_n, l) => { calls.push(`label ${l}`); },
    openIssue: async (title, _b, labels) => { calls.push(`issue ${labels.join(",")} ${title.slice(0, 16)}`); return 99; },
    compare: async () => ({ files: o.files ?? [], messages: ["Merge pull request #1"] }),
    revert: async (_b, sha) => { if (o.revertFails) throw new Error("push refused"); calls.push(`revert ${sha}`); return REVERT; },
  };
  return { gh, calls, posted };
}

/** Production that reports `live` commits in order, one per poll. */
function prod(seq: (string | null)[], storeOk = true): VerifyDeps & { polls: number } {
  let t = 0, i = 0;
  const p = {
    polls: 0,
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    get: async (url: string) => {
      if (url.endsWith("/health/store")) return { status: storeOk ? 200 : 503, json: async () => ({}) };
      p.polls++;
      const c = seq[Math.min(i++, seq.length - 1)];
      if (c === null) throw new Error("down");
      return { status: 200, json: async () => ({ ok: true, store: { ok: storeOk }, measurement: { commit: c } }) };
    },
  };
  return p;
}
const deps = (gh: Gh, verify: VerifyDeps, pauseVariable = ""): RunDeps => ({ gh, verify, pauseVariable, runUrl: "https://github.com/run/1", log: () => {} });

describe("dry run (policy inactive)", () => {
  it("reports 'would release' once, never merges or deploys", async () => {
    const f = fakeGh();
    const r = await runGate(policy("inactive"), 70, deps(f.gh, prod([MERGE.slice(0, 12)])));
    expect(r.decision.outcome).toBe("would-release");
    expect(f.calls).toEqual([]);
    expect(f.posted[0]).toContain("DRY RUN");
    await runGate(policy("inactive"), 70, deps(f.gh, prod([])));
    expect(f.posted).toHaveLength(1); // same SHA + outcome: no second comment
  });
  it("a RED change is labelled for the owner and never merged", async () => {
    const f = fakeGh({ files: [".github/release-policy.json"] });
    const r = await runGate(policy("active"), 70, deps(f.gh, prod([])));
    expect(r.decision.outcome).toBe("owner");
    expect(f.calls).toEqual(["label needs-owner-go"]);
  });
  it("the owner pause switch blocks an otherwise perfect release", async () => {
    const f = fakeGh();
    const r = await runGate(policy("active"), 70, deps(f.gh, prod([]), "off"));
    expect(r.decision.outcome).toBe("refuse");
    expect(f.calls).toEqual([]);
  });
  it("a forged review (wrong login) does not release", async () => {
    const f = fakeGh({ comments: [{ body: `<!-- secval-ai-review verdict=PASS sha=${SHA} reviewer=x -->`, login: "stranger", association: "NONE", created_at: "t" }] });
    const r = await runGate(policy("active"), 70, deps(f.gh, prod([])));
    expect(r.decision.outcome).toBe("wait");
    expect(f.calls).toEqual([]);
  });
});

describe("active release", () => {
  it("merges the exact SHA with audit trailers, starts CI, verifies production, records evidence", async () => {
    const f = fakeGh();
    const r = await runGate(policy("active"), 70, deps(f.gh, prod(["old000000000", MERGE.slice(0, 12)])));
    expect(f.calls).toEqual([`merge 70 ${SHA} trailer`, "ci integration"]);
    expect(r.verify?.ok).toBe(true);
    expect(r.rolledBack).toBeNull();
    expect(f.posted.at(-1)).toContain("production verified");
  });

  it("deployment failure: opens an incident (pauses releases), reverts, redeploys and verifies the rollback", async () => {
    const f = fakeGh();
    // Never shows the merge commit (deploy failed), then shows the revert.
    let phase = 0;
    const v = prod([]);
    v.get = async (url) => {
      if (url.endsWith("/health/store")) return { status: 200, json: async () => ({}) };
      const commit = phase === 0 ? "old000000000" : REVERT.slice(0, 12);
      return { status: 200, json: async () => ({ ok: true, store: { ok: true }, measurement: { commit } }) };
    };
    const g = { ...f.gh, revert: async (b: string, s: string) => { phase = 1; return f.gh.revert(b, s); } };
    const r = await runGate(policy("active"), 70, deps(g, v));
    expect(r.verify?.ok).toBe(false);
    expect(r.incident).toBe(99);
    expect(r.rolledBack).toBe(REVERT);
    expect(f.calls).toEqual([`merge 70 ${SHA} trailer`, "ci integration", "issue release-incident Release incident", `revert ${MERGE}`, "ci integration"]);
    expect(f.posted.at(-1)).toMatch(/rolled back .* production verified/);
  });

  it("unhealthy store after deploy is a failed verification", async () => {
    const f = fakeGh();
    const r = await runGate(policy("active"), 70, deps(f.gh, prod([MERGE.slice(0, 12)], false)));
    expect(r.verify?.ok).toBe(false);
    expect(r.incident).toBe(99);
  });

  it("if the automatic revert fails, the incident stays open and the evidence says how to roll back by hand", async () => {
    const f = fakeGh({ revertFails: true });
    const r = await runGate(policy("active"), 70, deps(f.gh, prod([null])));
    expect(r.rolledBack).toBeNull();
    expect(r.incident).toBe(99);
    expect(f.posted.at(-1)).toContain("Render dashboard");
  });
});

describe("verifyDeploy", () => {
  it("times out when production never reports the commit", async () => {
    const r = await verifyDeploy("https://x", MERGE, { timeoutMs: 60_000, pollMs: 10_000 }, prod(["old000000000"]));
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("not live within 1 min");
  });
  it("survives production being unreachable for a while", async () => {
    const r = await verifyDeploy("https://x", MERGE, { timeoutMs: 60_000, pollMs: 10_000 }, prod([null, null, MERGE.slice(0, 12)]));
    expect(r.ok).toBe(true);
  });
});

describe("real git revert (no fake)", () => {
  it("reverts a merge commit on the branch, pushes it, and the rollback commit carries the audit line", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { gitRevert } = await import("../scripts/release/run.js");
    const root = mkdtempSync(join(tmpdir(), "rev-"));
    const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
    execFileSync("git", ["init", "-q", "--bare", "-b", "integration", join(root, "o.git")]);
    const w = join(root, "w");
    execFileSync("git", ["clone", "-q", join(root, "o.git"), w]);
    sh(w, "checkout", "-q", "-b", "integration");
    sh(w, "commit", "-q", "--allow-empty", "-m", "base");
    sh(w, "checkout", "-q", "-b", "feature");
    execFileSync("sh", ["-c", "echo bad > f.txt"], { cwd: w });
    sh(w, "add", "f.txt");
    sh(w, "commit", "-q", "-m", "feature");
    sh(w, "checkout", "-q", "integration");
    sh(w, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    const merge = sh(w, "rev-parse", "HEAD");
    sh(w, "push", "-q", "origin", "integration");
    // Simulate the runner: no global git identity, a fresh clone.
    const runner = join(root, "r");
    execFileSync("git", ["clone", "-q", join(root, "o.git"), runner]);
    const prev = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const rev = gitRevert("integration", merge, runner);
      expect(rev).toMatch(/^[0-9a-f]{40}$/);
      expect(execFileSync("git", ["--git-dir", join(root, "o.git"), "rev-parse", "integration"], { encoding: "utf8" }).trim()).toBe(rev);
      expect(execFileSync("git", ["--git-dir", join(root, "o.git"), "log", "-1", "--format=%B", "integration"], { encoding: "utf8" })).toContain(`Auto-Rollback: ${merge}`);
      expect(execFileSync("git", ["--git-dir", join(root, "o.git"), "ls-tree", "--name-only", "integration"], { encoding: "utf8" })).not.toContain("f.txt");
    } finally {
      process.env.GIT_CONFIG_GLOBAL = prev.g; process.env.GIT_CONFIG_NOSYSTEM = prev.s;
      if (prev.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      if (prev.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    }
  });
  it("refuses a malformed SHA or branch before running git", async () => {
    const { gitRevert } = await import("../scripts/release/run.js");
    expect(() => gitRevert("integration; rm -rf /", "a".repeat(40))).toThrow();
    expect(() => gitRevert("integration", "HEAD")).toThrow();
  });
});

describe("push audit (detect and alert)", () => {
  it("a capped compare list (300+ files) cannot prove nothing protected changed", async () => {
    const f = fakeGh();
    f.gh.compare = async () => ({ files: Array.from({ length: 300 }, (_, i) => `public/f${i}.js`), messages: [] });
    expect(await runAudit(real, SHA, MERGE, deps(f.gh, prod([])))).toBe(99);
  });
  it("protected files reaching integration without an Owner-Approval line open an incident", async () => {
    const f = fakeGh({ files: [".github/release-policy.json"] });
    expect(await runAudit(real, SHA, MERGE, deps(f.gh, prod([])))).toBe(99);
  });
  it("an Owner-Approval line or GREEN-only files open nothing", async () => {
    const ok = fakeGh({ files: [".github/release-policy.json"] });
    ok.gh.compare = async () => ({ files: [".github/release-policy.json"], messages: ["Merge\n\nOwner-Approval: cmsg_123"] });
    expect(await runAudit(real, SHA, MERGE, deps(ok.gh, prod([])))).toBeNull();
    expect(await runAudit(real, SHA, MERGE, deps(fakeGh({ files: ["public/app.js"] }).gh, prod([])))).toBeNull();
  });
});
