import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, loadPolicy, parsePolicy, type ChangedFile, type Policy } from "../scripts/release/policy.js";
import { decide, type GateInput } from "../scripts/release/gate.js";

// SECVAL-SRD-001: these tests are the proof that the standing delegation cannot
// release RED work, cannot be steered by a PR, and fails closed. This file is
// itself RED in the policy, so no automatic release can weaken it.

const real = loadPolicy();
const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const file = (filename: string, patch = "+const x = 1;", status = "modified"): ChangedFile => ({ filename, status, additions: 1, deletions: 0, patch });
const marker = (o: Partial<Record<string, string>> = {}) =>
  `<!-- secval-ai-review verdict=${o.verdict ?? "PASS"} sha=${o.sha ?? SHA} reviewer=${o.reviewer ?? "session_rev"}${o.extra ?? ""} -->`;
const policy = (status: Policy["status"] = "inactive"): Policy => ({ ...real, status });

function input(over: Partial<GateInput> = {}, pr: Partial<GateInput["pr"]> = {}): GateInput {
  return {
    policy: policy(),
    pauseVariable: "",
    stopIssues: [],
    pr: {
      number: 70, state: "open", draft: false, merged: false, base: "integration", baseRepo: real.repository, headRepo: real.repository,
      headSha: SHA, author: "1903978-prog", mergeable: true, mergeableState: "clean", body: "Fix\n\nAuthor-Session: session_dev\n", ...pr,
    },
    behindBy: 0,
    checks: [{ name: "check", status: "completed", conclusion: "success", head_sha: SHA }],
    comments: [{ body: marker(), login: "1903978-prog", association: "OWNER", created_at: "2026-11-21T06:00:00Z" }],
    files: [file("public/app.js")],
    production: { backupMode: "on", lastDrillOk: true },
    ...over,
  };
}

describe("policy file", () => {
  it("parses, names this repo and integration, and ships inactive (dry run only)", () => {
    expect(real.repository).toBe("1903978-prog/anti-hacker");
    expect(real.target_branch).toBe("integration");
    expect(real.status).toBe("inactive");
  });
  it("a malformed or incomplete policy throws (callers then release nothing)", () => {
    expect(() => parsePolicy("{")).toThrow();
    expect(() => parsePolicy(JSON.stringify({ ...real, status: "always" }))).toThrow();
    expect(() => parsePolicy(JSON.stringify({ ...real, red_paths: [] }))).toThrow();
  });
});

describe("self-protection: the delegation cannot widen its own authority", () => {
  const protectedFiles = [
    ".github/release-policy.json", ".github/workflows/auto-release.yml", ".github/workflows/ci.yml", "scripts/release/gate.ts",
    "scripts/release/policy.ts", "scripts/release/run.ts", "test/release-gate.test.ts", "test/release-run.test.ts",
    "CLAUDE.md", "AGENTS.md", "EENDIGO_AEOS.md", "docs/policies/EEN-REL-001.md", ".claude/settings.json",
    "server/governance/killswitch.ts", "server/governance/policy.ts", "server/audit/log.ts", "server/ownership/allowlist.ts",
    "server/notify/email.ts", "server/deploy/rollback.ts", "render.yaml", "scripts/start.sh",
  ];
  it.each(protectedFiles)("%s is RED", (f) => expect(classify(real, [file(f)]).tier).toBe("RED"));
  it("renaming a protected file away is RED", () => {
    expect(classify(real, [{ ...file("docs/x.json"), status: "renamed", previous_filename: ".github/release-policy.json" }]).tier).toBe("RED");
  });
  it("a RED file is not released even when CI, review and owner switches all say go", () => {
    const d = decide(input({ policy: policy("active"), files: [file("public/app.js"), file(".github/release-policy.json")] }));
    expect(d.outcome).toBe("owner");
  });
});

describe("classification", () => {
  it("ordinary app, UI, test and doc changes are GREEN", () => {
    expect(classify(real, [file("public/app.js"), file("server/health/score.ts"), file("test/score.test.ts"), file("docs/x.md")]).tier).toBe("GREEN");
  });
  it("migrations, scheduler, backup, scanning and dependencies are AMBER", () => {
    for (const f of ["server/migrations.ts", "server/schedule/x.ts", "server/backup/x.ts", "server/scan/x.ts", "package.json"]) {
      expect(classify(real, [file(f)]).tier, f).toBe("AMBER");
    }
  });
  it("a path the policy does not name is RED (fail closed)", () => {
    expect(classify(real, [file("Dockerfile")]).tier).toBe("RED");
    expect(classify(real, [file("bin/tool")]).tier).toBe("RED");
  });
  it("deleting a test, a missing diff, or no files at all is RED", () => {
    expect(classify(real, [file("test/score.test.ts", "", "removed")]).tier).toBe("RED");
    expect(classify(real, [{ filename: "server/x.ts", status: "modified", additions: 5, deletions: 0 }]).tier).toBe("RED");
    expect(classify(real, []).tier).toBe("RED");
  });
  it.each([
    ["server/x.ts", "+db.exec('DROP TABLE findings')", "sql-delete"],
    ["server/x.ts", "+db.exec(`DELETE FROM audit_log`)", "sql-delete"],
    ["server/x.ts", "+const k = process.env.NEW_API_KEY;", "env-access"],
    ["server/x.ts", "+await fetch('https://api.resend.com/emails')", "outside-send"],
    ["test/score.test.ts", "+it.skip('x', () => {})", "test-disabled"],
    ["server/x.ts", "+// eslint-disable-next-line", "lint-disabled"],
    ["server/x.ts", "+import { release } from './governance/killswitch.js';", "kill-switch"],
  ])("%s adding %s is RED (%s)", (f, patch, id) => {
    const c = classify(real, [file(f, patch)]);
    expect(c.tier).toBe("RED");
    expect(c.reasons.join(" ")).toContain(id);
  });
  it.each([
    ["server/app.ts", "-  app.use(\"/api\", apiAuth(apiToken, wrongTokens, appTokens));"],
    ["server/scan/active.ts", "-  if (isEngaged(db)) return refused;"],
    ["server/health/x.ts", "-  app.use(noStore());"],
    ["server/dbarch/engine.ts", "-  const ro = readOnly(client);"],
  ])("removing a safety call in %s is RED", (f, patch) => expect(classify(real, [file(f, patch)]).tier).toBe("RED"));
  it.each([
    "+const k = process.env[\"RESEND_API_KEY\"];",
    "+const { RESEND_API_KEY } = process.env;",
    "+++i; const k = process.env.RESEND_API_KEY;",
    "+const k = process [\"env\"];",
  ])("credential access in any spelling is RED: %s", (patch) => expect(classify(real, [file("server/x.ts", patch)]).tier).toBe("RED"));
  it("a split e-mail host is still an outbound call (AMBER), and sending needs a credential, which is RED", () => {
    expect(classify(real, [file("server/x.ts", "+await fetch('https://api.re' + 'send.com/emails');")]).tier).toBe("AMBER");
    expect(classify(real, [file("server/x.ts", "+await fetch(u);")]).tier).toBe("AMBER");
    expect(classify(real, [file("server/x.ts", "+await fetch(u, { headers: { authorization: process.env.K } });")]).tier).toBe("RED");
  });
  it("app wiring, auth, integrity and read-only DB guards are RED paths", () => {
    for (const f of ["server/app.ts", "server/index.ts", "server/integrity.ts", "server/dbarch/readonly.ts", "server/dbarch/permissions.ts"]) {
      expect(classify(real, [file(f)]).tier, f).toBe("RED");
    }
  });
  it("a patch-less file (binary, submodule, renamed without diff) is RED", () => {
    expect(classify(real, [{ filename: "public/logo.png", status: "added", additions: 0, deletions: 0 }]).tier).toBe("RED");
  });
  it("content rules ignore removed non-safety lines and markdown", () => {
    expect(classify(real, [file("server/x.ts", "-db.exec('DROP TABLE x')")]).tier).toBe("GREEN");
    expect(classify(real, [file("docs/x.md", "+never DROP TABLE")]).tier).toBe("GREEN");
  });
  it("too many files or lines is RED", () => {
    expect(classify(real, Array.from({ length: 41 }, (_, i) => file(`public/f${i}.js`))).tier).toBe("RED");
    expect(classify(real, [{ ...file("public/a.js"), additions: 1501 }]).tier).toBe("RED");
  });
});

describe("gate decisions", () => {
  it("all green while inactive: dry run says it would release, never releases", () => {
    expect(decide(input()).outcome).toBe("would-release");
  });
  it("all green while active: release", () => {
    expect(decide(input({ policy: policy("active") })).outcome).toBe("release");
  });

  describe("owner controls stop everything at once", () => {
    it("revoked", () => expect(decide(input({ policy: policy("revoked") })).outcome).toBe("refuse"));
    it.each(["OFF", "off!", "stop", "false", "0", "paused"])("pause variable %s pauses (only unset or on runs)", (v) =>
      expect(decide(input({ policy: policy("active"), pauseVariable: v })).outcome).toBe("refuse"));
    it("pause variable on runs", () => expect(decide(input({ policy: policy("active"), pauseVariable: "on" })).outcome).toBe("release"));
    it("open stop or incident issue", () => expect(decide(input({ policy: policy("active"), stopIssues: [12] })).reasons[0]).toContain("#12"));
    it("stop issues unreadable", () => expect(decide(input({ policy: policy("active"), stopIssues: null })).outcome).toBe("refuse"));
  });

  describe("wrong target or source", () => {
    it("fork", () => expect(decide(input({}, { headRepo: "evil/anti-hacker" })).outcome).toBe("refuse"));
    it("other base branch", () => expect(decide(input({}, { base: "main" })).outcome).toBe("refuse"));
    it("other repository", () => expect(decide(input({}, { baseRepo: "1903978-prog/compplan" })).outcome).toBe("refuse"));
    it("untrusted author", () => expect(decide(input({}, { author: "stranger" })).outcome).toBe("refuse"));
    it("closed PR", () => expect(decide(input({}, { state: "closed" })).outcome).toBe("refuse"));
    it("draft waits", () => expect(decide(input({}, { draft: true })).outcome).toBe("wait"));
  });

  describe("failed or missing checks", () => {
    it("a failed check on the exact SHA refuses", () => {
      const d = decide(input({ checks: [{ name: "check", status: "completed", conclusion: "failure", head_sha: SHA }] }));
      expect(d.outcome).toBe("refuse");
    });
    it("any other failed check on the SHA also refuses", () => {
      const checks = [...input().checks!, { name: "extra", status: "completed", conclusion: "timed_out", head_sha: SHA }];
      expect(decide(input({ checks })).outcome).toBe("refuse");
    });
    it("a pass on an older SHA does not count", () => {
      expect(decide(input({ checks: [{ name: "check", status: "completed", conclusion: "success", head_sha: OLD }] })).outcome).toBe("wait");
    });
    it("a running check waits", () => {
      expect(decide(input({ checks: [{ name: "check", status: "in_progress", conclusion: null, head_sha: SHA }] })).outcome).toBe("wait");
    });
    it("checks unreadable refuses", () => expect(decide(input({ checks: null })).outcome).toBe("refuse"));
    it("files unreadable refuses", () => expect(decide(input({ files: null })).outcome).toBe("refuse"));
  });

  describe("compromised approval conditions", () => {
    const c = (body: string, login = "1903978-prog", association = "OWNER") => [{ body, login, association, created_at: "t" }];
    it("review for an older SHA does not count", () => expect(decide(input({ comments: c(marker({ sha: OLD })) })).outcome).toBe("wait"));
    it("a FAIL on this SHA beats a PASS", () => expect(decide(input({ comments: [...c(marker()), ...c(marker({ verdict: "FAIL" }))] })).outcome).toBe("refuse"));
    it("a review marker from a stranger is ignored", () => expect(decide(input({ comments: c(marker(), "stranger", "NONE") })).outcome).toBe("wait"));
    it("a review marker from a non-owner association is ignored", () => expect(decide(input({ comments: c(marker(), "1903978-prog", "CONTRIBUTOR") })).outcome).toBe("wait"));
    it("a marker hidden in the PR body is ignored", () => expect(decide(input({ comments: [] }, { body: `Author-Session: s\n${marker()}` })).outcome).toBe("wait"));
    it("self-review (reviewer = author session) refuses", () => expect(decide(input({ comments: c(marker({ reviewer: "session_dev" })) })).outcome).toBe("refuse"));
    it("no Author-Session line refuses", () => expect(decide(input({}, { body: "Fix" })).outcome).toBe("refuse"));
    it("malformed marker (short SHA) is ignored", () => expect(decide(input({ comments: c(marker({ sha: "abc123" })) })).outcome).toBe("wait"));
  });

  describe("what was tested is what ships", () => {
    it("behind the target branch waits", () => expect(decide(input({ behindBy: 2 })).outcome).toBe("wait"));
    it("comparison unreadable refuses", () => expect(decide(input({ behindBy: null })).outcome).toBe("refuse"));
    it("a non-number comparison (NaN) refuses", () => expect(decide(input({ behindBy: NaN })).outcome).toBe("refuse"));
    it("production backup off: a deploy would reset the store, so it goes to the owner", () =>
      expect(decide(input({ policy: policy("active"), production: { backupMode: "off", lastDrillOk: null } })).outcome).toBe("owner"));
    it("production unreadable refuses", () => expect(decide(input({ policy: policy("active"), production: null })).outcome).toBe("refuse"));
    it("merge conflict refuses", () => expect(decide(input({}, { mergeable: false, mergeableState: "dirty" })).outcome).toBe("refuse"));
    it("mergeability unknown waits", () => expect(decide(input({}, { mergeable: null })).outcome).toBe("wait"));
  });

  describe("AMBER controls", () => {
    const amber = (o: Partial<GateInput> = {}, extra = " impact=assessed rollback=ok") =>
      input({ policy: policy("active"), files: [file("server/migrations.ts"), file("test/migrations.test.ts")], comments: [{ body: marker({ extra }), login: "1903978-prog", association: "OWNER", created_at: "t" }], production: { backupMode: "on", lastDrillOk: true }, ...o });
    it("all controls met releases", () => expect(decide(amber()).outcome).toBe("release"));
    it("no test changed goes to the owner", () => expect(decide(amber({ files: [file("server/migrations.ts")] })).outcome).toBe("owner"));
    it("review without impact assessment goes to the owner", () => expect(decide(amber({}, "")).outcome).toBe("owner"));
    it("data change with backup off goes to the owner", () => expect(decide(amber({ production: { backupMode: "off", lastDrillOk: null } })).outcome).toBe("owner"));
    it("data change with failed restore drill goes to the owner", () => expect(decide(amber({ production: { backupMode: "on", lastDrillOk: false } })).outcome).toBe("owner"));
    it("data change with unreadable production refuses", () => expect(decide(amber({ production: null })).outcome).toBe("refuse"));
  });
});

describe("workflow cannot be steered by PR code", () => {
  const wf = readFileSync(".github/workflows/auto-release.yml", "utf8");
  it("never uses pull_request_target and never checks out the PR head", () => {
    expect(wf).not.toMatch(/pull_request_target/);
    expect(wf).not.toMatch(/head\.sha|head_ref|refs\/pull/);
    expect(wf).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  });
  it("has no default permissions, uses only the short-lived workflow token, and never cancels a running release", () => {
    expect(wf).toMatch(/^permissions: \{\}$/m);
    expect(wf).not.toMatch(/secrets\./);
    expect(wf).toMatch(/cancel-in-progress: false/);
  });
  it("only an OWNER comment can trigger the gate from a comment, and PR numbers are digits only", () => {
    expect(wf).toContain("github.event.comment.author_association == 'OWNER'");
    expect(wf).toContain("*[!0-9]*");
  });
});
