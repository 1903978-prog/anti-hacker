# SECVAL-SRD-001: Standing release delegation for Secval

Status: **INACTIVE (dry run only)**. Machine-readable source: `.github/release-policy.json`. Enforcement: `scripts/release/` run by `.github/workflows/auto-release.yml`. Proof: `test/release-gate.test.ts`, `test/release-run.test.ts`.

This repository only (`1903978-prog/anti-hacker`, branch `integration`, Render service `secval`). It grants nothing in any other repository.

## What it delegates (once active)
For a GREEN or AMBER PR that passes every check below, the workflow merges that exact commit, starts CI on `integration` so Render deploys it (`autoDeployTrigger: checksPass`), checks production, and rolls back if production is not healthy. No per-release GO from Livio.

## Tiers
| Tier | Covers | Machine may release? |
|---|---|---|
| GREEN | app code under `server/`, `public/`, `test/`, `docs/`, `reports/`, `eees/`, other `scripts/`, `.engineering/` notes, README, tsconfig, eslint config | Yes, after all checks |
| AMBER | `server/migrations.ts`, `server/db.ts`, `server/schedule/`, `server/backup/`, `server/scan/`, `package.json`, `package-lock.json`; any added outbound call (`fetch(` or a URL) in app code | Only if: a test changed in the same PR; the review says `impact=assessed rollback=ok`; at most 600 changed lines; for migration/db/backup changes, production reports backup mode `on` and a passed restore drill. Otherwise it goes to Livio |
| RED | the policy and workflows (`.github/`), release code (`scripts/release/`), its tests, `CLAUDE.md`, `AGENTS.md`, AEOS files, `.claude/`, `docs/policies/`, Render/Litestream config and start scripts, the safety layer (`server/governance/`, `server/audit/`, `server/ownership/`, `server/middleware.ts`, `server/app.ts`, `server/index.ts`, `server/integrity.ts`, the read-only database guards in `server/dbarch/`), e-mail (`server/notify/`), rollback (`server/deploy/`); any path not listed; deleted tests; unreadable diffs; more than 40 files or 1,500 lines; added lines that delete data (`DROP`/`TRUNCATE`/`DELETE FROM`), read any configuration or credential (`process.env` in any spelling), name an e-mail or payment provider, skip or focus a test, disable lint or type checks, or touch the scan kill switch; removed or changed lines that call an auth, audit, approval, kill-switch, read-only or ownership control | **Never.** Labelled `needs-owner-go`; Livio's own approval as today |

## Checks on every release (all must pass, any unreadable input fails closed)
1. Policy `active`; pause variable unset or `on` (any other value pauses); no open issue labelled `release-stop` or `release-incident`.
2. Base repo and branch are this repo and `integration`; not a fork; PR open, not draft; author is a trusted login.
3. Tier GREEN, or AMBER with its controls.
4. Required check `check` (type check, lint, tests, page check) passed on the exact head SHA; no other check failed on it.
5. Independent AI review marker on the exact head SHA, in a comment by the owner account, `verdict=PASS`, reviewer session different from the PR's `Author-Session:` line; any `FAIL` on that SHA blocks.
6. PR is not behind `integration` and is cleanly mergeable.
6a. Production reports backup mode `on` (on the free plan a deploy without Litestream resets the store and its audit trail).
7. Merge uses GitHub's `sha` guard (refused if the head moved) and writes `Auto-Release`, `Tier`, `Released-SHA`, `Review`, `Evidence-Run` trailers.
8. Production `/health` reports the merged commit, `ok: true`, store ok, and `/health/store` answers 200, within 25 minutes.
9. On failure: incident issue (pauses all releases), automatic `git revert` of the merge, CI, and verification of the rollback. If the revert fails, the evidence names the Render dashboard rollback.

## Owner controls (each works immediately)
- **Pause:** open an issue with label `release-stop` ([new stop issue](https://github.com/1903978-prog/anti-hacker/issues/new?labels=release-stop&title=STOP+automatic+releases)), or set repo variable `SECVAL_AUTO_RELEASE` to `off`.
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
- Content rules are text patterns: deliberately disguised code (for example a provider name split across strings) can slip past one rule; sending or paying still needs a credential, which is RED, and any outbound call is at least AMBER.
- Not yet proven live: that Render's `checksPass` accepts the CI run the workflow starts on `integration`. If it does not, the first release fails verification, rolls back and pauses itself (safe).
- With branch protection on `integration` that blocks direct pushes, the automatic revert cannot push; the incident then names the Render dashboard rollback.
- A Render free-tier deploy can exceed 25 minutes on a cold build; that counts as a failed verification and triggers rollback (safe, but noisy).

## Why routine releases are not automatic yet (21 Nov 2026)
1. This policy is not on `integration` yet and ships `inactive`: Livio's approval of the PR installs it in dry run only.
2. `EENDIGO_AEOS.md` section 4 (canonical, central) demands a separate written approval for every merge and deploy and forbids an app rule from removing that. Proposed fix: `docs/policies/AEOS-standing-delegation-proposal.md`, adopted centrally.
3. CLAUDE.md section 4 rule 2 ("ship it") and EEN-REL-001 rule 2 (exact-SHA GO): both now carry an exception that applies only while this policy is `active`.
4. Activation itself is a RED change (`status` to `active`), so only Livio's own approval can do it.
5. No separate machine identity: every session and the owner share one GitHub account, so the controls detect and limit but cannot fully prevent a session acting by hand (see residual risks).
