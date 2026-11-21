# Proposed AEOS amendment (v1.1): repository-specific standing delegation

Status: PROPOSAL, not adopted. `EENDIGO_AEOS.md` is canonical and is changed centrally only (version bump, re-install in every repo); this file is not part of it.

Why: AEOS v1.0 section 4 requires a separate written approval for every merge and production deploy, and says an application rule may not remove that. So no repository can run routine releases without a per-release GO, whatever its own policy says. This is the blocker recorded in `.engineering/BLOCKERS.md` (21 Nov 2026).

Proposed text, added to section 4 after "Each release has its own approval.":

> Exception: the user may approve, in writing, a standing release delegation for one named repository. It must be a version-controlled policy that (1) lists the change classes it covers and treats everything else as outside it; (2) is enforced by automation that runs from the protected branch, checks CI, an independent review and the exact commit SHA, and fails closed; (3) excludes changes to the delegation itself, security and audit controls, credentials and access, external messages, financial actions and irreversible data deletion; (4) gives the user an immediate pause and revoke; (5) verifies production after every release and rolls back on failure; (6) records evidence for every release. While such a delegation is active, the user's approval of it is the written approval for the releases it covers. It never covers another repository.

First user: Secval, `docs/policies/SECVAL-SRD-001.md`.
