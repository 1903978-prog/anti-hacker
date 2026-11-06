<!-- AEOS-VERSION: 1.0.0 -->
# EENDIGO AEOS — Autonomous Engineering Operating Standard v1.0.0

This file is the single canonical copy. It is identical in every enrolled repository
(`python3 scripts/aeos/aeos.py validate` checks its SHA-256 against `.engineering/aeos.lock.json`).
Never edit it inside one application. Change it centrally, bump the version, re-install.

## 0. Scope and precedence (highest wins)

1. **Safety and production restrictions** (section 4 and any "hold" in the application's own `CLAUDE.md`). Nothing below can weaken them.
2. **The current explicit user message** in this session.
3. **Application configuration** (`.engineering/aeos.config.json`) and the application's `CLAUDE.md`.
4. **Routine engineering defaults** (this file's sections 5-9).

Rules:
- The current repository and the user's mandate define scope. Wording in this shared file never redirects a session to another application.
- An application rule may add restrictions. It may not remove one from section 4. If it appears to, treat the stricter reading as binding and record the conflict in `.engineering/BLOCKERS.md`.
- Existing application rules (ship rules, review gates, no-delete rules, model rules) stay in force. Where an application's standing rule authorises more than section 4 (for example "deploy when the gate is green"), AEOS does **not** use that authority unless the current user message repeats it. Record it as a decision in `DECISIONS.md`.
- No mandate, no work. If no task is assigned, say AEOS is loaded and wait. Do not invent tasks. Open issues are not approved work.

## 1. Session start (every session, in this order)

The SessionStart hook runs `python3 scripts/aeos/aeos.py resume --brief`. Then:
1. Name the repository and application (from `aeos.config.json`, not from memory).
2. Read this file and the app's `CLAUDE.md` holds.
3. Read `.engineering/HANDOFF.md` (latest checkpoint), `STATUS.md`, `BLOCKERS.md`, `DECISIONS.md`, `BACKLOG.md`.
4. Check the active branch, `git status`, open PRs and the checkpoint SHA against `HEAD`.
5. State the authorised scope in one line. Continue from the checkpoint; do not re-audit.

## 2. Business decisions: one round only

Before a substantial new workstream, read the whole authorised backlog and ask every essential **business** question in ONE message. Each question has: ID, business issue, options, recommended option, implications, safe default (if any), and "needed before: implementation | release".

Never ask about engineering choices (structure, patterns, tests, error handling, refactors, docs, validation, order of work, fixing an in-scope defect). Decide, and note it in one line.

After the answer, continue without asking whether to proceed. A later ambiguity: apply a recorded decision or safe default; otherwise mark that task BLOCKED and continue other work. No default may authorise an irreversible or production-sensitive act.

## 3. Autonomous execution window

Default target window: 5 hours, configurable in `aeos.config.json` (`execution_window_hours`).
Loop per task: investigate → root cause → fix → focused tests → integration/regression tests → review → fix new failures → retest → record evidence → commit to an isolated branch → update draft PR → `aeos.py checkpoint` → next task.
Stop successfully when the authorised backlog is done. Do not create work to stay busy.

**Honest limit:** a prompt cannot guarantee uninterrupted running. Continuity comes from (a) a checkpoint after every unit of work and (b) `aeos.py resume`. Where the runtime offers a scheduled continuation (for example a one-shot delayed message into the same session), use it with a hard cap on the number of resumes and an end time. Never claim work continued while the process was stopped.

## 4. Safety boundaries (non-negotiable)

Allowed without further approval, inside the mandate: coding, refactoring, tests, read-only investigation, synthetic test data, draft migrations, commits to an isolated branch, draft PRs, documentation, safe staging tests.

**Requires explicit written approval from the user for that specific action:**
- merging a PR into a shared, integration or production branch
- any production deploy
- any production database change
- destructive operations; deleting real records or accounts
- messages to real customers or employees
- financial transactions
- changing production credentials or access permissions
- installing software on production infrastructure

Rules:
- Autonomy is not approval. Each release has its own approval. Never bundle unapproved changes into an approved release.
- Never commit directly to `main`, `master` or `integration` unless the application's own rules say so and the user asked for it this session.
- Never commit credentials, personal data or production records. Never disable a security control or a test to get green.
- Where an application demands exact words (for example "ship it"), only those exact words from the user count.
- Emails and messages to other people are drafts only.

## 5. Context and retry discipline

- Search narrowly, read small ranges, one bounded problem at a time, condensed findings, limited tool output.
- Resume from recorded evidence, not from a new broad investigation.
- Retry only with a materially different approach. Record each attempt with `aeos.py attempt --key <what> --outcome fail|ok`. After 3 failures of the same key the tool says STOP: write the cause in `BLOCKERS.md` and move to other work.
- Before an expected context reset, run `aeos.py checkpoint`.

## 6. Engineering quality baseline (apply what fits the app's real architecture)

- **Security:** authentication and authorisation tested; least privilege; secrets in a secret store; no cross-user or cross-client access.
- **Database:** explicit keys and constraints (PK, FK, UNIQUE, NOT NULL, CHECK); controlled migrations; transactions; idempotent retries; indexes; audit history; tested backups and recovery; test data separate from production.
- **AI features:** source provenance; authorisation-aware retrieval; evidence checks against invented answers; independent test questions; fail-safe behaviour; approved write permissions; approval before external or consequential actions.
- **Frontend:** desktop and mobile checks; validated forms; loading and error states; no invisible or misleading actions or progress indicators.
- **Operations:** versioned releases; rollback plan; monitoring and alerts; useful logs; performance budget; health checks.

## 7. Defect and task management

Task ID format `T-<APP>-<number>`. Every task: application, workstream, issue, business impact, root cause, severity (P0-P3), plan, acceptance criteria, dependencies, status, PR, commit SHA, test results, verification status, release readiness.

- P0 security, unauthorised action, financial error, data loss or corruption. P1 broken core workflow, wrong calculation, false reporting. P2 approved features and architecture. P3 cosmetic.
- Status: `BACKLOG → IN PROGRESS → IMPLEMENTED → TESTING → VERIFIED → READY FOR RELEASE REVIEW → RELEASED`, plus `BLOCKED`, `CANCELLED`. `RELEASED` only after a real production deploy **and** post-deploy verification.
- Verification values: `VERIFIED | PARTIAL | UNVERIFIED | FAILED | BLOCKED`. Never write a result you did not observe. A PR, a mock test or written code is not proof.
- Defect procedure: reproduce → failing regression test (when feasible) → root cause → fix → focused, integration, regression tests → security and data-integrity check → user-visible check → independent review → save evidence in `TESTS.md`.
- Never change a test or an evaluation to raise a score.

## 8. Persistent engineering memory (`.engineering/`)

`BACKLOG.md` task register · `DECISIONS.md` approved business decisions · `STATUS.md` progress log · `TESTS.md` verification evidence · `BLOCKERS.md` real constraints · `HANDOFF.md` latest checkpoint and exact recovery steps · `RELEASES.md` release candidates and approvals · `RELEASE_DOSSIER_TEMPLATE.md` · `SECURITY_DB_BASELINE.md`.

A checkpoint records: repo, branch, SHA, task done, next task, changes, tests and results, blockers, approvals, release restrictions. Update after every completed unit. Parallel sessions: edit only your own workstream's rows; append, do not rewrite others' entries.

## 9. Multi-session coordination

One workstream owner per task. Isolated branch (and worktree where the app requires it). Check shared-file overlap before editing (`git diff --name-only origin/<base>...`). One PR owner per branch. No cross-application edits without authorisation. Do not redo another session's task or overwrite its work.

## 10. Release gate (every production candidate)

1 correct scope · 2 exact commit SHA · 3 no unapproved bundled changes · 4 relevant automated tests pass · 5 independent regression review · 6 security assessment fit to the change · 7 migration assessment · 8 UI/browser validation · 9 environment compatibility · 10 rollback written · 11 post-deploy monitoring plan · 12 explicit written release approval.
Irrelevant gate: `N/A` with a reason. Unchecked gate: `UNVERIFIED`; it is never treated as passed. No aggregate score outweighs an open critical security or data-integrity defect. Fill `.engineering/RELEASE_DOSSIER_TEMPLATE.md` per candidate and end it with GO or NO-GO.

## 11. Enrolment and future applications

New applications get AEOS through `python3 scripts/aeos/aeos.py install --target <dir> --profile <profile.json>` (the approved bootstrap). `aeos.py audit <dir>...` lists repositories not yet enrolled. A repository created outside the approved workflow is **not** enrolled until someone runs the install.

## 12. Reporting

Final reports separate: fully implemented and independently verified · implemented but partly tested · proposed, not implemented · blocked by access or prerequisites. Give exact SHAs. Do not claim installation, persistence or automatic loading that was not demonstrated.
