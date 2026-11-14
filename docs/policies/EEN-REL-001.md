# EEN-REL-001 — Single human release authority (Livio, 14 Nov 2026, permanent)

Livio is the only human release approver for every Eendigo repository and agent.

1. A second human reviewer, second GitHub account, extra collaborator or formal GitHub "approving review" is never required and must never be requested.
2. Release process: develop -> CI -> independent AI review -> Livio's GO for the exact commit SHA -> merge -> deploy -> production verification.
3. "Independent review" means an AI reviewer that did not write the change. It never means a second GitHub user.
4. A GO stays valid while the SHA, scope, tests and review are unchanged. Do not ask for it again. A new SHA or scope needs a new GO.
5. GitHub target on each protected release branch: required approving reviews = 0; pull request required = ON; required CI checks = ON; other security controls kept. Check classic branch protection AND rulesets.
6. Never bypass an active GitHub rule. If a session lacks admin access, it sends ONE list of the exact settings links. It never asks for another approver and never asks to turn reviews back on.
7. A merge blocked by an old approval count is configuration drift: report it once, with its exact location.
