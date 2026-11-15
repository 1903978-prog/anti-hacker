import process from "node:process";
import { pathToFileURL } from "node:url";

export const TARGETS = [
  { repo: "1903978-prog/lm-op-model", base: "master" },
  { repo: "1903978-prog/compplan", base: "master" },
  { repo: "1903978-prog/nexus-eendigo", base: "main" },
  { repo: "1903978-prog/10bonds", base: "main" },
  { repo: "1903978-prog/anti-hacker", base: "integration" },
];

export const LABEL = {
  ready: "orchestrator:ready",
  active: "orchestrator:active",
  blocked: "orchestrator:blocked",
  failed: "orchestrator:failed",
  completed: "orchestrator:completed",
  review: "orchestrator:review-ready",
  release: "orchestrator:release-decision",
};

export function chooseNext(issues) {
  const priority = (i) => {
    const names = (i.labels || []).map((x) => typeof x === "string" ? x : x.name);
    if (names.some((x) => /(^|\s)P0\b/i.test(x))) return 0;
    if (names.some((x) => /(^|\s)P1\b/i.test(x))) return 1;
    if (names.some((x) => /(^|\s)P2\b/i.test(x))) return 2;
    return 3;
  };
  return issues
    .filter((i) => i.state === "open" && !i.pull_request)
    .filter((i) => (i.labels || []).some((x) => (typeof x === "string" ? x : x.name) === LABEL.ready))
    .filter((i) => !(i.labels || []).some((x) => [LABEL.active, LABEL.blocked, LABEL.failed, LABEL.completed, LABEL.review, LABEL.release].includes(typeof x === "string" ? x : x.name)))
    .sort((a, b) => priority(a) - priority(b) || Date.parse(a.created_at) - Date.parse(b.created_at) || a.number - b.number)[0] || null;
}

export function taskState(task) {
  const state = String(task?.state || "unknown").toLowerCase();
  if (["queued", "in_progress", "idle"].includes(state)) return "active";
  if (state === "waiting_for_user") return "blocked";
  if (state === "completed") return "completed";
  if (["failed", "timed_out", "cancelled"].includes(state)) return "failed";
  return "unknown";
}

export function summarizeChecks(checkRuns = [], statuses = []) {
  const bad = new Set(["failure", "error", "cancelled", "timed_out", "action_required", "stale"]);
  if (checkRuns.some((x) => x.status === "completed" && bad.has(x.conclusion))) return "failure";
  if (statuses.some((x) => bad.has(x.state))) return "failure";
  const all = [...checkRuns.map((x) => x.status === "completed" && ["success", "neutral", "skipped"].includes(x.conclusion)), ...statuses.map((x) => x.state === "success")];
  return all.length && all.every(Boolean) ? "success" : "pending";
}

export function linkedIssueNumber(body = "") {
  const m = body.match(/(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)/i);
  return m ? Number(m[1]) : null;
}

const API = "https://api.github.com";
const token = process.env.COPILOT_ASSIGNMENT_TOKEN;
const request = globalThis.fetch.bind(globalThis);
const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function api(path, options = {}) {
  const response = await request(`${API}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} returned ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

async function pages(path) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error(`Expected list from ${path}`);
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

function taskIssue(task) {
  const full = task.repository_full_name || task.repository?.full_name || task.repository || task.repo;
  const number = task.issue_number || task.issue?.number || task.number;
  return typeof full === "string" && Number.isInteger(Number(number)) ? { repo: full, number: Number(number) } : null;
}

async function ensureLabels(repo) {
  const present = new Set((await pages(`/repos/${repo}/labels`)).map((x) => x.name));
  for (const [name, color, description] of [
    [LABEL.ready, "1d76db", "Opt this issue into the single global coding-agent queue"],
    [LABEL.active, "fbca04", "A coding-agent task is active"],
    [LABEL.blocked, "d93f0b", "A genuine external or owner decision blocks this task"],
    [LABEL.failed, "b60205", "The coding-agent task failed and needs triage"],
    [LABEL.completed, "0e8a16", "Coding-agent implementation completed"],
    [LABEL.review, "5319e7", "A regular PR is ready for independent review"],
    [LABEL.release, "e99695", "A release decision is required from Livio"],
  ]) if (!present.has(name)) await api(`/repos/${repo}/labels`, { method: "POST", body: JSON.stringify({ name, color, description }) });
}

async function setIssueLabels(repo, issue, add, remove = []) {
  const current = (await api(`/repos/${repo}/issues/${issue}`)).labels.map((x) => x.name);
  const next = [...new Set([...current.filter((x) => !remove.includes(x)), ...add])];
  if (next.sort().join("\n") !== current.slice().sort().join("\n")) await api(`/repos/${repo}/issues/${issue}`, { method: "PATCH", body: JSON.stringify({ labels: next }) });
}

async function noteOnce(repo, issue, marker, text) {
  const comments = await pages(`/repos/${repo}/issues/${issue}/comments`);
  if (comments.some((c) => (c.body || "").includes(marker))) return;
  await api(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body: `${text}\n\n<!-- ${marker} -->` }) });
}

async function auditOpenPullRequests() {
  for (const { repo } of TARGETS) {
    const prs = await pages(`/repos/${repo}/pulls?state=open`);
    for (const pr of prs) {
      const sha = pr.head?.sha;
      if (!sha) continue;
      const [checks, status] = await Promise.all([
        api(`/repos/${repo}/commits/${sha}/check-runs`),
        api(`/repos/${repo}/commits/${sha}/status`),
      ]);
      const result = summarizeChecks(checks.check_runs || [], status.statuses || []);
      globalThis.console.log(`PR ${repo}#${pr.number} head=${sha} checks=${result} check_runs=${(checks.check_runs || []).length} statuses=${(status.statuses || []).length}`);
      const actor = pr.user?.login || "";
      const agentPr = actor.includes("copilot") || String(pr.head.ref).toLowerCase().includes("copilot");
      const issue = linkedIssueNumber(pr.body || "");
      if (!agentPr || !issue || result === "pending") continue;
      const marker = `orchestrator-pr-${pr.number}-${sha}-${result}`;
      if (result === "failure") {
        await setIssueLabels(repo, issue, [LABEL.blocked], [LABEL.active, LABEL.ready, LABEL.review]);
        await noteOnce(repo, issue, marker, `Automated check failure on PR #${pr.number}, exact head SHA \`${sha}\`. The task is blocked pending diagnosis. No merge or deployment was performed.`);
      } else {
        await setIssueLabels(repo, issue, [LABEL.review], [LABEL.active, LABEL.ready, LABEL.blocked]);
        await noteOnce(repo, issue, marker, `All checks currently reported for PR #${pr.number} passed on exact head SHA \`${sha}\`. Independent review and Livio's exact-SHA release decision remain required. No merge or deployment was performed.`);
      }
    }
  }
}

async function syncTasks(tasks) {
  for (const task of tasks) {
    const category = taskState(task);
    const ref = taskIssue(task);
    globalThis.console.log(`Agent task id=${task.id || task.task_id || "unknown"} state=${task.state || "unknown"} category=${category} issue=${ref ? `${ref.repo}#${ref.number}` : "unmapped"}`);
    if (!ref || !TARGETS.some((x) => x.repo === ref.repo)) continue;
    if (category === "completed") {
      await setIssueLabels(ref.repo, ref.number, [LABEL.completed], [LABEL.active, LABEL.ready, LABEL.blocked, LABEL.failed]);
      await noteOnce(ref.repo, ref.number, `orchestrator-task-${task.id || task.task_id || ref.number}-completed`, `Copilot completed the implementation task. Review its PR and exact-SHA checks; release still requires the stated backup evidence and Livio's explicit approval.`);
    } else if (category === "failed") {
      await setIssueLabels(ref.repo, ref.number, [LABEL.failed], [LABEL.active, LABEL.ready]);
      await noteOnce(ref.repo, ref.number, `orchestrator-task-${task.id || task.task_id || ref.number}-failed`, `Copilot task ended in \`${task.state}\`. This is marked failed for triage. No merge or deployment was performed.`);
    } else if (category === "blocked") {
      await setIssueLabels(ref.repo, ref.number, [LABEL.blocked], [LABEL.active, LABEL.ready]);
      await noteOnce(ref.repo, ref.number, `orchestrator-task-${task.id || task.task_id || ref.number}-blocked`, `Copilot is waiting for user input on this task. It is marked blocked; the global queue may continue with the next eligible issue. No merge or deployment was performed.`);
    } else if (category === "active") await setIssueLabels(ref.repo, ref.number, [LABEL.active], [LABEL.ready, LABEL.blocked, LABEL.failed]);
  }
}

async function copilotEnabled(repo) {
  const [owner, name] = repo.split("/");
  const result = await api("/graphql", {
    method: "POST",
    headers: { "GraphQL-Features": "issues_copilot_assignment_api_support,coding_agent_model_selection" },
    body: JSON.stringify({ query: `query { repository(owner: "${owner}", name: "${name}") { suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) { nodes { ... on Bot { login } } } } }` }),
  });
  if (result.errors?.length) throw new Error(`Copilot eligibility query failed for ${repo}: ${JSON.stringify(result.errors).slice(0, 300)}`);
  return (result.data?.repository?.suggestedActors?.nodes || []).some((x) => x.login === "copilot-swe-agent");
}

export async function run() {
  if (!token) throw new Error("Missing COPILOT_ASSIGNMENT_TOKEN; refusing to assign work.");
  for (const { repo } of TARGETS) await ensureLabels(repo);
  await auditOpenPullRequests();
  // Fail closed: if the agent-task API is unavailable or its response is malformed, do not dispatch another task.
  const data = await api("/agents/tasks");
  const tasks = Array.isArray(data) ? data : data?.tasks;
  if (!Array.isArray(tasks)) throw new Error("Agent tasks API returned an unknown shape; refusing to dispatch.");
  await syncTasks(tasks);
  const active = tasks.filter((t) => taskState(t) === "active");
  const unknown = tasks.filter((t) => taskState(t) === "unknown");
  if (unknown.length) throw new Error(`Found ${unknown.length} agent task(s) with unknown state; refusing to dispatch.`);
  if (active.length) {
    globalThis.console.log(`Queue held: ${active.length} active agent task(s); no new assignment.`);
    return;
  }
  const candidates = [];
  const enabled = new Map();
  for (const { repo, base } of TARGETS) {
    enabled.set(repo, await copilotEnabled(repo));
    const issues = await pages(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL.ready)}`);
    for (const issue of issues) {
      if (issue.pull_request || issue.labels.some((x) => [LABEL.active, LABEL.blocked, LABEL.failed, LABEL.completed, LABEL.review, LABEL.release].includes(x.name))) continue;
      if (enabled.get(repo)) candidates.push({ repo, base, issue });
      else {
        await setIssueLabels(repo, issue.number, [LABEL.blocked], [LABEL.ready]);
        await noteOnce(repo, issue.number, `orchestrator-copilot-unavailable-${repo}`, `This task is opted in, but GitHub does not list Copilot cloud agent as assignable in \`${repo}\`. The queue has paused this issue pending Copilot availability. No changes were made.`);
      }
    }
  }
  candidates.sort((a, b) => {
    const p = (x) => x.issue.labels.some((l) => /\bP0\b/i.test(l.name)) ? 0 : x.issue.labels.some((l) => /\bP1\b/i.test(l.name)) ? 1 : x.issue.labels.some((l) => /\bP2\b/i.test(l.name)) ? 2 : 3;
    return p(a) - p(b) || Date.parse(a.issue.created_at) - Date.parse(b.issue.created_at) || a.issue.number - b.issue.number;
  });
  const next = candidates[0];
  if (!next) { globalThis.console.log("Queue empty: no open issue carries orchestrator:ready."); return; }
  const { repo, base, issue } = next;
  const assignment = {
    assignees: ["copilot-swe-agent[bot]"],
    agent_assignment: {
      target_repo: repo,
      base_branch: base,
      custom_instructions: "Work only on this issue in an isolated branch. Preserve all existing functionality and unrelated changes. Run focused tests plus the repository's relevant regression, integration, build and security checks; fix failures attributable to the change. Open a regular, non-draft PR after basic validation and include the full tested 40-character head SHA, commands and results. Never merge, enable auto-merge, deploy, run production migrations, or change production data. Escalate genuine blockers with evidence. Do not claim a test or backup was validated unless evidence is recorded. Before any later release, require two independently validated database backups and two independently validated code backups for this application, plus Livio's explicit approval for the exact SHA and named action."
    }
  };
  await api(`/repos/${repo}/issues/${issue.number}/assignees`, { method: "POST", body: JSON.stringify(assignment) });
  await setIssueLabels(repo, issue.number, [LABEL.active], [LABEL.ready]);
  await noteOnce(repo, issue.number, `orchestrator-assigned-${issue.number}`, `Assigned to GitHub Copilot by the global engineering queue. Repository: \`${repo}\`; base: \`${base}\`. Task state and CI are audited by scheduled runs. No merge or deployment is authorized.`);
  globalThis.console.log(`Assigned next task: ${repo}#${issue.number} (${issue.title})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => { globalThis.console.error(`Orchestrator stopped safely: ${error.message}`); process.exitCode = 1; });
}


