# Global engineering orchestrator

The controller runs from `1903978-prog/anti-hacker` and scans these five repositories in one serialized queue:

| Repository | Work branch |
|---|---|
| `1903978-prog/lm-op-model` | `master` |
| `1903978-prog/compplan` (ATENA) | `master` |
| `1903978-prog/nexus-eendigo` | `main` |
| `1903978-prog/10bonds` | `main` |
| `1903978-prog/anti-hacker` | `integration` |

Only open issues labelled `orchestrator:ready` are eligible. The controller selects one at a time, prioritizing P0, then P1, then P2, then oldest creation time. An issue must be explicitly opted in; the controller does not assign arbitrary backlog items.

## Task state and audit trail

The labels `orchestrator:ready`, `active`, `blocked`, `failed`, `completed`, `review-ready`, and `release-decision` record queue state on the issue. Copilot task state, each open PR's exact 40-character head SHA, and check-run/status results are written to the GitHub Actions log. State changes and terminal PR check results receive a deduplicated issue comment. Unknown task states, an unavailable agent-task API, missing credentials, or malformed API responses stop dispatch safely.

The queue is global and serialized by an Actions concurrency group. A 15-minute schedule resumes the next eligible task after the prior Copilot task completes, fails, or is cancelled. `workflow_dispatch` supports an authorized manual audit. CI checks are read from each open PR; a Copilot PR with failed checks is marked blocked, while a Copilot PR with all reported checks passing is marked review-ready. An absent check remains pending.

## Required credential and activation

The workflow is inert until the repository secret `COPILOT_ASSIGNMENT_TOKEN` is configured. It must be a user-to-server token belonging to Livio and scoped to only the five repositories above. GitHub's current Copilot assignment API requires fine-grained token access to metadata read and actions, contents, issues, and pull requests read/write. Do not use an installation token: the agent-task API does not support server-to-server tokens. The secret is only passed to the scheduled/manual controller job; the job's `GITHUB_TOKEN` has `contents:read` only.

Copilot cloud agent must also be enabled and assignable in each repository. The controller checks `suggestedActors` before assignment and marks an opted-in issue blocked if Copilot is unavailable there.

## Release boundary

Copilot opens a regular PR after basic validation and runs the repository's applicable tests. The controller never merges, enables auto-merge, deploys, invokes production migrations, or writes production data. A review-ready label means only that all checks reported for that exact PR SHA passed; independent review and Livio's written exact-SHA authorization remain required.

Before any release, the PR must contain auditable evidence of **two independently validated database backups and two independently validated code backups for that application**, including backup identifiers, validation time, and validation result. Release evidence and the exact-SHA approval are release gates, not work-queue eligibility. Existing repository protections and release controls remain authoritative; this controller does not change them.

