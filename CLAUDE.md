# secval — standing rules for Claude

**What this is:** an authorized continuous security-validation platform — a
self-service scanner that Livio runs against **his own assets only**. The
governance/safety layer is the heart of the product: no capability that
touches a target may exist or run until that layer approves it.

## Hard rules (never break these)

1. **One branch.** All work merges into the `integration` branch. Do not
   create other long-lived branches.
2. **No ship without the word.** Do **not** open a PR, push to a remote, or
   deploy anything unless Livio writes the exact words **"ship it"**. Until
   then, commit locally to `integration` only.
3. **Tests stay fast.** Run only the tests for the module you touched, aiming
   for well under two minutes. CI is the full gate, not local runs.
4. **Warn before spending.** Warn Livio before any action that would consume
   GitHub Actions minutes or Render compute.
5. **Governance first.** Build and test the safety layer before any scanning
   capability. Scanning code must call the policy engine for approval and
   **cannot bypass or disable it**.
6. **Run the full gate before every push.** `npm run verify` runs exactly what
   CI runs (type check, lint, tests, page check). If Chromium is missing, set
   `PW_CHROMIUM` to an installed one (cloud sessions: `/opt/pw-browsers/chromium`).
   Any change to `public/` (colours, columns, links) must pass the page check,
   in light and dark. Do not push on a red or unrun `verify`. Rule 3 applies
   to editing loops only, not to the last run before a push.

## Safety invariants the code must uphold

- **Fail closed.** If the policy engine is unreachable or denies, the action
  does not run.
- **Allowlist only.** A URL not on the ownership allowlist can never be
  scanned. A domain cannot become scan-eligible until ownership is proven
  (DNS TXT record or a token file on the site, verified by the tool).
- **Resource caps.** Every scan is bounded: max requests/second, max total
  requests, max runtime, max retained response data, and zero data-mutating
  operations in the default profile. Exceeding any cap aborts the scan.
- **Immutable audit trail.** Every scan action is logged append-only
  (target, mode, who, when, result). Logs are never edited or deleted.
- **Kill switch.** A single switch stops all running scans immediately.
- **Retain findings, not data.** A scan keeps only the fact that a weakness
  exists, never the underlying data it read from a target.

## Stack

Node/Express 5 + (React client later) · better-sqlite3 for the store · zod for
validation · TypeScript (tsx to run, vitest to test) · hosted on Render.

## GitHub Actions rules (Livio, 28/10)

- No workflow runs on push to `claude/**` or other session branches. CI runs on pull requests, on the push to `integration` (Render waits for it) and on manual dispatch.
- Every workflow has a `concurrency` group with `cancel-in-progress: true`, and docs-only changes skip CI (`paths-ignore`).
- Live checks run once a night and once after a deploy, never on every push. The keep-awake ping is the one exception (public repo, free, never fails).
- Render deploys secval, so there is no "Deploy to Fly" workflow here.
- Never re-run a failed workflow to "see if it passes": reproduce it locally, fix the cause or remove the check.
- GitHub's own failure e-mails are an account setting (GitHub, Settings, Notifications, Actions); a workflow cannot turn them off.

## GitHub Actions rules (permanent, Livio 28/10/2026 — target under 50 cents/day across all repos)

- No workflow runs on push to `claude/**` or any session branch. Allowed triggers: `schedule`, `workflow_dispatch`, `pull_request` into the shipping branch only (with `paths-ignore: ["**.md", "docs/**"]`), and `workflow_run` after a successful deploy.
- Every check has a `concurrency` group with `cancel-in-progress: true` so a newer commit cancels older runs (backups/deploys: `false`).
- Live / link / tile checks: one scheduled run per night plus one run after a successful deploy; never on every push, never while a deploy is in progress.
- Deploys: sessions run `fly deploy` directly. No workflow may deploy on push (a "Deploy to Fly" workflow, if kept, is manual-only).
- A failing check is diagnosed from its logs and fixed at the cause (or removed if redundant). Never re-run a failed workflow just to see if it passes.
- Failure emails: only a nightly live-check failure on the production site may email Livio (one summary, sent by the app). Branch and PR check failures never email him.
- This repo is public (Actions minutes free). `keep-awake.yml` is a deliberate Render keep-awake ping that never fails; leave it.
