/**
 * Release runner for the standing delegation (SECVAL-SRD-001).
 *
 *   tsx scripts/release/run.ts gate  --pr <n>          decide; merge + deploy + verify when active
 *   tsx scripts/release/run.ts audit --before <sha> --after <sha>   flag RED pushes without an owner approval line
 *
 * Runs in GitHub Actions from the default branch (never from PR code), with
 * the workflow's own short-lived GITHUB_TOKEN. Nothing here prints a token.
 * While the policy is "inactive" the gate only reports what it would do.
 */
import { execFileSync } from "node:child_process";
import { loadPolicy, matchesAny, type ChangedFile, type Policy } from "./policy.js";
import { decide, type CheckRun, type Comment, type Decision, type PullInfo } from "./gate.js";
import { verifyDeploy, type VerifyDeps, type VerifyResult } from "./verify.js";

export interface Gh {
  pull(n: number): Promise<PullInfo>;
  files(n: number): Promise<ChangedFile[]>;
  checks(sha: string): Promise<CheckRun[]>;
  comments(n: number): Promise<Comment[]>;
  behindBy(base: string, sha: string): Promise<number>;
  stopIssues(labels: string[]): Promise<number[]>;
  production(url: string): Promise<{ backupMode: string; lastDrillOk: boolean | null } | null>;
  merge(n: number, sha: string, title: string, message: string): Promise<string>;
  dispatchCi(ref: string): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  label(n: number, label: string): Promise<void>;
  openIssue(title: string, body: string, labels: string[]): Promise<number>;
  compare(before: string, after: string): Promise<{ files: string[]; messages: string[] }>;
  /** Reverts a merge commit on the target branch and pushes; returns the revert SHA. */
  revert(branch: string, mergeSha: string): Promise<string>;
}

export interface RunDeps { gh: Gh; verify: VerifyDeps; pauseVariable: string | undefined; runUrl: string; log: (s: string) => void }

const safe = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };

export const EVIDENCE = "secval-release-evidence";

export function evidenceBody(p: Policy, d: Decision, runUrl: string, extra: string[] = []): string {
  const lines = [
    `<!-- ${EVIDENCE} sha=${d.sha} outcome=${d.outcome} -->`,
    `**Release gate (${p.policy_id} v${p.version}, policy ${p.status})**: ${label(d.outcome)}`,
    "",
    `| Item | Value |`, `|---|---|`,
    `| Exact SHA | \`${d.sha}\` |`,
    `| Tier | ${d.tier ?? "not classified"} |`,
    `| Independent review | ${d.review ? `${d.review.verdict} by ${d.review.reviewer}` : "none for this SHA"} |`,
    `| Evidence run | ${runUrl} |`,
    "",
    ...d.reasons.map((r) => `- ${r}`),
    ...extra.map((r) => `- ${r}`),
  ];
  return lines.join("\n");
}

function label(o: Decision["outcome"]): string {
  return {
    release: "released by the standing delegation",
    "would-release": "DRY RUN: would release (delegation not active)",
    wait: "waiting",
    refuse: "refused",
    owner: "needs Livio's approval (outside the standing delegation)",
  }[o];
}

export interface GateReport { decision: Decision; merged: string | null; verify: VerifyResult | null; rolledBack: string | null; incident: number | null }

export async function runGate(policy: Policy, prNumber: number, d: RunDeps): Promise<GateReport> {
  const { gh } = d;
  const pr = await gh.pull(prNumber);
  const files = await safe(() => gh.files(prNumber));
  const needsProd = files?.some((f) => matchesAny(f.filename, ["server/migrations.ts", "server/db.ts", "server/backup/**"])) ?? false;
  const decision = decide({
    policy,
    pauseVariable: d.pauseVariable,
    stopIssues: await safe(() => gh.stopIssues(policy.stop_labels)),
    pr,
    behindBy: await safe(() => gh.behindBy(policy.target_branch, pr.headSha)),
    checks: await safe(() => gh.checks(pr.headSha)),
    comments: await safe(() => gh.comments(prNumber)),
    files,
    production: needsProd ? await safe(() => gh.production(policy.production_url)) : null,
  });
  const report: GateReport = { decision, merged: null, verify: null, rolledBack: null, incident: null };
  d.log(`gate PR #${prNumber} ${decision.sha.slice(0, 12)}: ${decision.outcome} ${decision.reasons.join("; ")}`);
  if (decision.outcome === "wait") return report;

  // One evidence comment per SHA and outcome (re-runs do not spam the PR).
  const prior = (await safe(() => gh.comments(prNumber))) ?? [];
  const tag = `<!-- ${EVIDENCE} sha=${decision.sha} outcome=${decision.outcome} -->`;
  const already = prior.some((c) => c.body.includes(tag));
  if (decision.outcome !== "release") {
    if (!already) await gh.comment(prNumber, evidenceBody(policy, decision, d.runUrl));
    if (decision.outcome === "owner") await safe(() => gh.label(prNumber, "needs-owner-go"));
    return report;
  }

  // Release: merge only this exact SHA (GitHub refuses if the head moved).
  const t = decision.tier ?? "GREEN";
  const merged = await gh.merge(prNumber, decision.sha, `Auto-release PR #${prNumber} (${t})`, [
    `Auto-Release: ${policy.policy_id} v${policy.version}`,
    `Tier: ${t}`,
    `Released-SHA: ${decision.sha}`,
    `Review: ${decision.review?.verdict} ${decision.review?.reviewer}`,
    `Evidence-Run: ${d.runUrl}`,
  ].join("\n"));
  report.merged = merged;
  // A merge made with the workflow token does not start other workflows; start CI on the
  // target branch so Render (autoDeployTrigger: checksPass) deploys after it passes.
  // If this fails, verification times out below and the rollback path runs.
  await safe(() => gh.dispatchCi(policy.target_branch));
  const opts = { timeoutMs: policy.verify.timeout_minutes * 60_000, pollMs: policy.verify.poll_seconds * 1000 };
  report.verify = await verifyDeploy(policy.production_url, merged, opts, d.verify);
  if (report.verify.ok) {
    await gh.comment(prNumber, evidenceBody(policy, decision, d.runUrl, [`merged as \`${merged}\``, `production verified: ${report.verify.reasons.join("; ")}`]));
    return report;
  }

  // Verification failed: pause further releases, revert, redeploy the previous code, verify again.
  report.incident = await gh.openIssue(
    `Release incident: PR #${prNumber} failed production verification`,
    [`Auto-release of \`${merged}\` failed verification: ${report.verify.reasons.join("; ")}.`, "", "Automatic releases are paused while this issue is open. Close it to resume.", `Evidence: ${d.runUrl}`].join("\n"),
    ["release-incident"],
  );
  const extra = [`merged as \`${merged}\``, `production verification FAILED: ${report.verify.reasons.join("; ")}`, `incident #${report.incident} opened; automatic releases paused`];
  const reverted = await safe(() => gh.revert(policy.target_branch, merged));
  if (reverted) {
    report.rolledBack = reverted;
    await safe(() => gh.dispatchCi(policy.target_branch));
    const back = await verifyDeploy(policy.production_url, reverted, opts, d.verify);
    extra.push(`rolled back with revert \`${reverted}\`: ${back.ok ? "production verified" : `NOT verified (${back.reasons.join("; ")})`}`);
  } else extra.push("automatic revert FAILED: roll back from the Render dashboard (Deploys, pick the previous live deploy, Rollback)");
  await gh.comment(prNumber, evidenceBody(policy, decision, d.runUrl, extra));
  return report;
}

/** RED files pushed to the target branch without an Owner-Approval line open an incident (detect and alert). */
export async function runAudit(policy: Policy, before: string, after: string, d: RunDeps): Promise<number | null> {
  const c = await d.gh.compare(before, after);
  const red = c.files.filter((f) => matchesAny(f, policy.red_paths));
  if (!red.length) return null;
  if (c.messages.some((m) => /^Owner-Approval:\s*\S+/m.test(m))) return null;
  return d.gh.openIssue(
    `Release incident: protected files changed on ${policy.target_branch} without an owner approval line`,
    [`Push ${before.slice(0, 12)}..${after.slice(0, 12)} changed protected (RED) files without an \`Owner-Approval:\` line:`, ...red.map((f) => `- ${f}`), "", "Automatic releases are paused while this issue is open. If Livio approved this change, close the issue.", `Evidence: ${d.runUrl}`].join("\n"),
    ["release-incident"],
  );
}

/* ---------------- real GitHub client (Actions only) ---------------- */

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function githubClient(repo: string, token: string, f: typeof fetch = fetch): Gh {
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const r = await f(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status >= 300) throw new Error(`GitHub ${method} ${path.split("?")[0]} answered ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
  const pages = async (path: string, key?: string): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const j = await api("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const rows = (key ? o(j)[key] : j) as unknown[];
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  };
  return {
    async pull(n) {
      const p = o(await api("GET", `/pulls/${n}`));
      return {
        number: n, state: s(p.state), draft: p.draft === true, merged: p.merged === true,
        base: s(o(p.base).ref), baseRepo: s(o(o(p.base).repo).full_name), headRepo: s(o(o(p.head).repo).full_name),
        headSha: s(o(p.head).sha), author: s(o(p.user).login),
        mergeable: typeof p.mergeable === "boolean" ? p.mergeable : null, mergeableState: s(p.mergeable_state), body: s(p.body),
      };
    },
    async files(n) {
      return (await pages(`/pulls/${n}/files`)).map((x) => { const r = o(x); return { filename: s(r.filename), status: s(r.status), previous_filename: s(r.previous_filename) || undefined, additions: Number(r.additions) || 0, deletions: Number(r.deletions) || 0, patch: typeof r.patch === "string" ? r.patch : undefined }; });
    },
    async checks(sha) {
      return (await pages(`/commits/${sha}/check-runs`, "check_runs")).map((x) => { const r = o(x); return { name: s(r.name), status: s(r.status), conclusion: r.conclusion == null ? null : s(r.conclusion), head_sha: s(r.head_sha) }; });
    },
    async comments(n) {
      return (await pages(`/issues/${n}/comments`)).map((x) => { const r = o(x); return { body: s(r.body), login: s(o(r.user).login), association: s(r.author_association), created_at: s(r.created_at) }; });
    },
    async behindBy(base, sha) { return Number(o(await api("GET", `/compare/${base}...${sha}`)).behind_by); },
    async stopIssues(labels) {
      const all = new Set<number>();
      for (const l of labels) for (const x of await pages(`/issues?state=open&labels=${encodeURIComponent(l)}`)) all.add(Number(o(x).number));
      return [...all];
    },
    async production(url) {
      const r = await f(`${url}/health`, { signal: AbortSignal.timeout(90_000) });
      if (r.status !== 200) return null;
      const b = o(o(o(await r.json()).measurement).backup);
      return { backupMode: s(b.mode), lastDrillOk: typeof b.lastDrillOk === "boolean" ? b.lastDrillOk : null };
    },
    async merge(n, sha, title, message) {
      return s(o(await api("PUT", `/pulls/${n}/merge`, { sha, merge_method: "merge", commit_title: title, commit_message: message })).sha);
    },
    async dispatchCi(ref) { await api("POST", `/actions/workflows/ci.yml/dispatches`, { ref }); },
    async comment(n, body) { await api("POST", `/issues/${n}/comments`, { body }); },
    async label(n, l) { await api("POST", `/issues/${n}/labels`, { labels: [l] }); },
    async openIssue(title, body, labels) { return Number(o(await api("POST", `/issues`, { title, body, labels })).number); },
    async compare(before, after) {
      const c = o(await api("GET", `/compare/${before}...${after}`));
      return { files: (c.files as unknown[] ?? []).map((x) => s(o(x).filename)), messages: (c.commits as unknown[] ?? []).map((x) => s(o(o(x).commit).message)) };
    },
    async revert(branch, mergeSha) {
      const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
      git("fetch", "origin", branch);
      git("checkout", "-B", branch, `origin/${branch}`);
      git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "revert", "-m", "1", "--no-edit", mergeSha);
      git("commit", "--amend", "--no-edit", "-m", `Auto-rollback of ${mergeSha}`, "-m", `Auto-Rollback: ${mergeSha}\nReason: production verification failed`);
      git("push", "origin", branch);
      return git("rev-parse", "HEAD");
    },
  };
}

async function main(argv: string[]): Promise<number> {
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const policy = loadPolicy();
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  if (repo !== policy.repository) { console.log(`refused: running in ${repo || "unknown repo"}, policy is for ${policy.repository}`); return 1; }
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.log("refused: no workflow token"); return 1; }
  const deps: RunDeps = {
    gh: githubClient(repo, token),
    verify: { get: (u) => fetch(u, { signal: AbortSignal.timeout(90_000) }), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() },
    pauseVariable: process.env.PAUSE_VARIABLE,
    runUrl: `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    log: (m) => console.log(m),
  };
  if (argv[0] === "gate") {
    const n = Number(arg("--pr"));
    if (!Number.isInteger(n) || n <= 0) { console.log("refused: --pr missing"); return 1; }
    const r = await runGate(policy, n, deps);
    console.log(JSON.stringify({ outcome: r.decision.outcome, tier: r.decision.tier, sha: r.decision.sha, merged: r.merged, verified: r.verify?.ok ?? null, rolledBack: r.rolledBack, incident: r.incident }));
    return r.verify && !r.verify.ok ? 1 : 0;
  }
  if (argv[0] === "audit") {
    const before = arg("--before") ?? "", after = arg("--after") ?? "";
    if (!/^[0-9a-f]{40}$/.test(before) || !/^[0-9a-f]{40}$/.test(after) || /^0+$/.test(before)) { console.log("audit skipped: no before/after SHA"); return 0; }
    const n = await runAudit(policy, before, after, deps);
    console.log(n ? `incident #${n} opened` : "audit clean");
    return 0;
  }
  console.log("usage: run.ts gate --pr <n> | audit --before <sha> --after <sha>");
  return 1;
}

if (process.argv[1]?.endsWith("run.ts")) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e: unknown) => { console.log(`release runner failed closed: ${e instanceof Error ? e.message : "error"}`); process.exit(1); });
}
