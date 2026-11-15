# Copilot implementation and release workflow

Follow this policy for every change in this repository.

## Implement and open the PR
- Start from the current default branch and work on an isolated feature branch. Keep changes limited to the requested acceptance criteria, preserve unrelated work, and maintain compatibility.
- Implement the change, then run focused checks and basic validation available in the repository. Fix failures caused by the change before opening a PR.
- When basic validation passes, open a **regular, non-draft pull request** against the current default/release branch. Do not wait for every long-running check before opening it. Include the tested commit SHA, commands run, and results in the PR description. Continue monitoring checks and fix failures on the same branch.
- Do not claim a check ran if it did not. Name unavailable checks and explain the blocker. Keep unrelated local changes off the PR.

## Run all applicable checks
- Run every applicable CI, integration, regression, and security check configured for the change. Use documented repository commands; include migration, compatibility, and production-build checks when applicable.
- Never skip, weaken, or relabel a failing check to make a PR green. Separate infrastructure failures from code failures and retry only when the cause is understood.
- Re-run required checks after the final code change. Report evidence against the exact PR head SHA; older green runs do not validate a newer SHA.
- If CI does not start automatically, use an authorized manual workflow run on the PR head. If that is unavailable, record CI as pending and do not represent the change as release-ready.

## Independent review and release
- After CI evidence is available, request an independent ChatGPT review of the complete diff and test evidence for the exact PR head SHA. The review must report findings, unresolved risks, evidence, and a release recommendation.
- Copilot and ChatGPT must not merge, enable auto-merge, deploy, run production migrations, or edit production data.
- Only Livio may authorize a merge or production deployment. Authorization must be explicit, identify the exact commit SHA (prefer the full 40-character SHA), and state which action is approved. A merge approval is not deployment approval unless it explicitly says so.
- Follow every stricter repository-specific release gate. Never bypass branch protection, environment approval, release manifests, backups, migrations, or rollback checks. For repositories that deploy automatically after merge, the exact-SHA approval must explicitly authorize that production deployment too.
- Record the final SHA, independent review, required-check results, and live verification still outstanding. A merged PR is not proof that functionality is live.

This file guides Copilot behavior; it does not change GitHub organization settings, enable a missing Copilot agent, or override repository protections.
