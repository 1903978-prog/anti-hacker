# Engineering and release workflow

This standard applies to every change in this repository:

1. **Implement:** Copilot uses an isolated branch, delivers the requested scope, and completes basic validation.
2. **Open a PR:** As soon as basic validation passes, Copilot opens a regular, non-draft PR with the tested commit SHA and evidence. It then runs or monitors all applicable CI, integration, regression, and security checks.
3. **Review:** ChatGPT independently reviews the complete diff and exact-SHA check evidence, records findings and unresolved risks, and provides a release recommendation.
4. **Authorize:** Only Livio may authorize merge or production deployment. Approval must identify the exact commit SHA and action. Merge and deployment approval are separate unless Livio explicitly approves both.

Copilot and ChatGPT do not merge, enable auto-merge, deploy, run production migrations, or edit production data. Never bypass repository-specific branch protection, release manifests, environment approvals, backup, migration, rollback, or live-verification controls. A merged PR is not proof that its functionality is live.

Operational instructions: [Copilot instructions](../.github/copilot-instructions.md) and [pull request template](../.github/PULL_REQUEST_TEMPLATE.md).
