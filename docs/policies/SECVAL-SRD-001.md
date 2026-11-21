# SECVAL-SRD-001: Standing release delegation for Secval

Status: **INACTIVE (dry run only)**. Machine-readable source: `.github/release-policy.json`. Enforcement: `scripts/release/` run by `.github/workflows/auto-release.yml`. Proof: `test/release-gate.test.ts`, `test/release-run.test.ts`.

This repository only (`1903978-prog/anti-hacker`, branch `integration`, Render service `secval`). It grants nothing in any other repository.

## What it delegates (once active)
For a GREEN or AMBER PR that passes every check below, the workflow merges that exact commit, starts CI on `integration` so Render deploys it (`autoDeployTrigger: checksPass`), checks production, and rolls back if production is not healthy. No per-release GO from Livio.

## Tiers
| Tier | Covers | Machine may release? |
|---|---|---|
| GREEN | app code under `server/`, `public/`, `test/`, `docs/`, `reports/`, `eees/`, other `scripts/`, `.engineering/` notes, README, tsconfig, eslint config | Yes, after all checks |
| AMBER | `server/migrations.ts`, `server/db.ts`, `server/schedule/`, `server/backup/`, `server/scan/`, `package.json`, `package-lock.json` | Only if: a test changed in the same PR; the review says `impact=assessed rollback=ok`; at most 600 changed lines; for migration/db/backup changes, production reports backup mode `on` and a passed restore drill. Otherwise it goes to Livio |
| RED | the policy and workflows (`.github/`), release code (`scripts/release/`), its tests, `CLAUDE.md`, `AGENTS.md`, AEOS files, `.claude/`, `docs/policies/`, Render/Litestream config and start scripts, the safety layer (`server/governance/`, `server/audit/`, `server/ownership/`, `server/middleware.ts`), e-mail (`server/notify/`), rollback (`server/deploy/`); any path not listed; deleted tests; unreadable diffs; more than 40 files or 1,500 lines; added lines that delete data (`DROP`/`TRUNCATE`/`DELETE FROM`), use a credential (`process.env.*TOKEN/KEY/SECRET/PASSWORD`), call an outside e-mail or payment service, skip a test, disable lint, or touch the scan kill switch | **Never.** Labelled `needs-owner-go`; Livio's own approval as today |

## Checks on every release (all must pass, any unreadable input fails closed)
1. Policy `active`; pause variable not `off`; no open issue labelled `release-stop` or `release-incident`.
2. Base repo and branch are this repo and `integration`; not a fork; PR open, not draft; author is a trusted login.
3. Tier GREEN, or AMBER with its controls.
4. Required check `check` (type check, lint, tests, page check) passed on the exact head SHA; no other check failed on it.
5. Independent AI review marker on the exact head SHA, in a comment by the owner account, `verdict=PASS`, reviewer session different from the PR's `Author-Session:` line; any `FAIL` on that SHA blocks.
6. PR is not behind `integration` and is cleanly mergeable.
7. Merge uses GitHub's `sha` guard (refused if the head moved) and writes `Auto-Release`, `Tier`, `Released-SHA`, `Review`, `Evidence-Run` trailers.
8. Production `/health` reports the merged commit, `ok: true`, store ok, and `/health/store` answers 200, within 25 minutes.
9. On failure: incident issue (pauses all releases), automatic `git revert` of the merge, CI, and verification of the rollback. If the revert fails, the evidence names the Render dashboard rollback.

## Owner controls (each works immediately)
- **Pause:** open an issue with label `release-stop`, or set repo variable `SECVAL_AUTO_RELEASE` to `off`.
- **Resume:** close the issue / clear the variable.
- **Revoke:** change `status` to `revoked` (RED: needs Livio's approval).
- **Audit:** each PR gets an evidence comment per SHA and outcome; every machine merge carries trailers; workflow logs keep the run.
- **Detect:** a push to `integration` that changes RED files without an `Owner-Approval: <approval id>` line opens a `release-incident` issue (pauses releases).

## Writing a PR for automatic release
PR body has `Author-Session: <session id>`. A different session reviews the exact head SHA and comments `<!-- secval-ai-review verdict=PASS sha=<full sha> reviewer=<its session id> -->` (AMBER adds ` impact=assessed rollback=ok`). Mark the PR ready. The gate does the rest.

## Residual risks (honest limits)
- All sessions use Livio's own GitHub account. That account can still merge by hand, edit the policy, set the variable, or write review and approval lines. The gate cannot tell a session from Livio. Mitigations: RED never auto-merges, the gate runs only from `integration`'s own copy, the push audit flags protected changes without an approval line. Real prevention needs branch protection on `integration` plus a separate machine identity; see the activation notes.
- The AI review is a marker in a comment, not a cryptographic proof that another session wrote it.
- Reverting code does not undo data changes; that is why data changes are AMBER with backup and restore-drill checks, and data deletion is RED.
- A Render free-tier deploy can exceed 25 minutes on a cold build; that counts as a failed verification and triggers rollback (safe, but noisy).
