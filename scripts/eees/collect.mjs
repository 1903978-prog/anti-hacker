#!/usr/bin/env node
/**
 * EEES v1.0 repository collector. Plain Node 20+, no dependencies, so any
 * Eendigo repository (or its GitHub workflow) can run it without installing
 * anything:
 *
 *   node collect.mjs --app <id> [--repo <dir>] [--run] [--audit] [--out file]
 *   node collect.mjs --app <id> --merge eees/evidence/<id>.json   (update in place)
 *
 * It checks only what a repository can prove: CI, lockfile, tests, secrets in
 * tracked files, docs, deploy config. Everything it records is evidence level
 * "synthetic" (repository inspection), so it can never lift a dimension above
 * 6/10 on its own. It never reads production and never changes anything
 * except the --out / --merge file.
 *
 *   --run    also runs the repo's own typecheck, lint and test scripts (npm)
 *   --audit  also runs `npm audit --omit=dev` (needs network)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);

const app = opt("--app");
const repo = opt("--repo") ?? process.cwd();
if (!app) {
  console.error("usage: node collect.mjs --app <id> [--repo dir] [--run] [--audit] [--out file | --merge evidence.json]");
  process.exit(2);
}

const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
let commit = "unknown";
let files = [];
try {
  commit = git("rev-parse", "HEAD");
  files = git("ls-files").split("\n").filter(Boolean);
} catch {
  console.error(`collect: ${repo} is not a git repository`);
  process.exit(2);
}
const now = new Date().toISOString();
const where = `${repo.replace(/\/$/, "").split("/").pop()}@${commit.slice(0, 8)}`;
const has = (re) => files.filter((f) => re.test(f));
const read = (f) => {
  try {
    return readFileSync(join(repo, f), "utf8");
  } catch {
    return "";
  }
};
const pkg = existsSync(join(repo, "package.json")) ? JSON.parse(read("package.json")) : null;

const checks = {};
const record = (id, ok, note, kind = "measurement") => {
  checks[id] = {
    status: ok === null ? "unknown" : ok ? "verified" : "failed",
    ...(ok ? { level: "synthetic" } : {}),
    evidence: ok === null ? [] : [{ link: `eees collector: ${where} (${id})`, kind, date: now, environment: "repository" }],
    note,
  };
};

// D01.2 migrations
const mig = has(/(^|\/)(migrations?|drizzle|alembic)(\/|\.ts$|\.js$|\.py$)/i);
record("D01.2", mig.length > 0, mig.length ? `${mig.length} migration file(s), e.g. ${mig[0]}` : "no migrations directory or file found (mark N/A with a reviewer if the app has no database)");

// D09.1 secrets in tracked files (working tree, not history)
const SECRET_PATTERNS = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub token", /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{60,}/],
  ["API secret key", /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["database URL with password", /\b(postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^\s:@/'"]+:[^\s@/'"$<{]{6,}@/],
];
const skip = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock)$|\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|zip|gz|bundle|sqlite|db)$/i;
const hits = [];
for (const f of files) {
  if (skip.test(f)) continue;
  const text = read(f);
  if (text.length > 2_000_000) continue;
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${f}: ${name}`);
}
record("D09.1", hits.length === 0, hits.length ? `${hits.length} possible secret(s): ${hits.slice(0, 5).join("; ")} (values not copied)` : `0 secret patterns in ${files.length} tracked files (working tree only, history not scanned)`);

// D09.2 secret files tracked
const envFiles = has(/(^|\/)\.env(\.[^/]*)?$|\.pem$|(^|\/)id_(rsa|ed25519)$/).filter((f) => !/\.(example|sample|template)$/.test(f));
record("D09.2", envFiles.length === 0, envFiles.length ? `tracked secret file(s): ${envFiles.join(", ")}` : "no .env, .pem or key files tracked");

// D25.1 / D25.2 / D26.1 own scripts
const scripts = pkg?.scripts ?? {};
const runScript = (name) => {
  const r = spawnSync("npm", ["run", "--silent", name], { cwd: repo, encoding: "utf8", timeout: 15 * 60_000 });
  return { ok: r.status === 0, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-2).join(" | ").slice(0, 240) };
};
for (const [id, name] of [["D25.1", "typecheck"], ["D25.2", "lint"], ["D26.1", "test"]]) {
  if (!scripts[name]) {
    record(id, false, `no "${name}" script in package.json`);
  } else if (flag("--run")) {
    const r = runScript(name);
    record(id, r.ok, `npm run ${name}: ${r.ok ? "passed" : "FAILED"} (${r.tail})`, "test-run");
  } else {
    record(id, null, `"${name}" script exists; not run (use --run)`);
  }
}

// D26.2 skipped / focused tests
const testFiles = has(/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/);
const skipped = [];
for (const f of testFiles) {
  const t = read(f);
  const m = t.match(/\b(it|test|describe)\.(skip|only|todo)\s*\(|\bx(it|describe)\s*\(|@pytest\.mark\.skip/g);
  if (m) skipped.push(`${f} (${m.length})`);
}
record("D26.2", testFiles.length === 0 ? null : skipped.length === 0, testFiles.length === 0 ? "no test files found" : skipped.length ? `skipped/focused tests in: ${skipped.slice(0, 5).join(", ")}` : `0 skipped or focused tests in ${testFiles.length} test files`);

// D27.1 / D27.2 CI workflows
const wfs = has(/^\.github\/workflows\/[^/]+\.ya?ml$/);
const wfText = wfs.map((f) => [f, read(f)]);
const prTest = wfText.filter(([, t]) => /pull_request/.test(t) && /(npm (run )?test|vitest|pytest|npm run verify|go test)/.test(t));
record("D27.1", prTest.length > 0, prTest.length ? `tests run on pull requests: ${prTest.map(([f]) => f).join(", ")}` : `${wfs.length} workflow(s), none runs tests on pull_request`);
const noConc = wfText.filter(([, t]) => !/concurrency:/.test(t) || !/cancel-in-progress:/.test(t)).map(([f]) => f);
record("D27.2", wfs.length === 0 ? null : noConc.length === 0, wfs.length === 0 ? "no workflows" : noConc.length ? `missing concurrency/cancel-in-progress: ${noConc.join(", ")}` : `all ${wfs.length} workflows have a concurrency group`);

// D28.1 deploy configuration in repo
const deploy = has(/^(render\.ya?ml|fly\.toml|Dockerfile|Procfile|vercel\.json|netlify\.toml|app\.ya?ml)$/);
record("D28.1", deploy.length > 0, deploy.length ? `deploy config: ${deploy.join(", ")}` : "no deploy configuration file in the repository");

// D29.1 lockfile
const lock = has(/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Pipfile\.lock)$/);
record("D29.1", lock.length > 0, lock.length ? `lockfile: ${lock[0]}` : "no lockfile tracked");

// D29.2 dependency audit
if (flag("--audit") && files.includes("package-lock.json")) {
  const r = spawnSync("npm", ["audit", "--omit=dev", "--json"], { cwd: repo, encoding: "utf8", timeout: 120_000 });
  try {
    const v = JSON.parse(r.stdout).metadata.vulnerabilities;
    const bad = (v.high ?? 0) + (v.critical ?? 0);
    record("D29.2", bad === 0, `npm audit (production deps): ${v.critical ?? 0} critical, ${v.high ?? 0} high, ${v.moderate ?? 0} moderate`, "test-run");
  } catch {
    record("D29.2", null, "npm audit gave no readable answer (network?)");
  }
}

// D29.3 automated dependency updates
const upd = has(/^(\.github\/dependabot\.ya?ml|renovate\.json5?|\.github\/renovate\.json5?)$/);
record("D29.3", upd.length > 0, upd.length ? `configured: ${upd[0]}` : "no Dependabot or Renovate configuration");

// D30.1 README + ownership
const readme = has(/^README(\.md)?$/i);
const owners = has(/^(CLAUDE\.md|AGENTS\.md|CODEOWNERS|\.github\/CODEOWNERS|docs\/CODEOWNERS)$/);
record("D30.1", readme.length > 0 && owners.length > 0, `README: ${readme[0] ?? "missing"}; ownership/rules: ${owners.join(", ") || "missing"}`);

// D30.3 engineering register freshness
const reg = has(/^\.engineering\/(STATUS|HANDOFF|BACKLOG)\.md$/);
if (reg.length) {
  const last = git("log", "-1", "--format=%cI", "--", ...reg);
  const days = last ? (Date.now() - Date.parse(last)) / 86_400_000 : Infinity;
  record("D30.3", days <= 7, `.engineering/ last changed ${last || "never"} (${Number.isFinite(days) ? Math.floor(days) : "?"} days ago)`);
} else record("D30.3", false, "no .engineering/ register (STATUS, HANDOFF or BACKLOG)");

const fragment = { standard: "EEES", standardVersion: "1.0.0", app, collectedAt: now, commit, checks };

const mergeInto = opt("--merge");
if (mergeInto) {
  const ev = JSON.parse(readFileSync(mergeInto, "utf8"));
  if (ev.app !== app) {
    console.error(`collect: ${mergeInto} is for app "${ev.app}", not "${app}"`);
    process.exit(2);
  }
  ev.checks = ev.checks ?? {};
  for (const [id, c] of Object.entries(checks)) {
    // Never overwrite stronger evidence (a production measurement or a reviewed N/A).
    const old = ev.checks[id];
    if (old && (old.status === "na" || (old.level && old.level !== "synthetic"))) continue;
    if (c.status === "unknown" && old) continue;
    ev.checks[id] = c;
  }
  writeFileSync(mergeInto, JSON.stringify(ev, null, 2) + "\n");
  console.log(`collect: merged ${Object.keys(checks).length} repository checks into ${mergeInto}`);
} else {
  const out = JSON.stringify(fragment, null, 2) + "\n";
  if (opt("--out")) writeFileSync(opt("--out"), out);
  else process.stdout.write(out);
}
