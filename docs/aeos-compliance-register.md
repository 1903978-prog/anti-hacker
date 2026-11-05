# AEOS compliance register (05 Nov 2026)

Canonical standard: `EENDIGO_AEOS.md` v1.0.0. Results below are from this session only; "not observed" means not tested.

| Application | Repository | AEOS state | Branch / PR | Validated (this session) | Gaps / owner |
|---|---|---|---|---|---|
| Secval | 1903978-prog/anti-hacker | Installed, LOCAL commit only | claude/fervent-euler-yurhdu, no push, no PR | `aeos.py validate` OK, 15 tests OK | Push + PR need Livio's exact words "ship it" (Secval rule 2). Rollback process UNVERIFIED. Owner: Livio |
| Nexus | 1903978-prog/nexus-eendigo | Installed in draft PR | claude/aeos-install | validate OK, 15 tests OK | Prod/rollback fields UNVERIFIED; render.yaml role unclear; standing "deploy when green" rule not used by AEOS. Owner: Livio |
| ATLAS / CompPlan | 1903978-prog/compplan | Installed in draft PR | claude/aeos-install | validate OK, 15 tests OK | `session:finish` auto-merges to master: AEOS needs written approval first. Rollback UNVERIFIED. Owner: Livio |
| LM OpModel | 1903978-prog/lm-op-model | Installed in draft PR | claude/aeos-install | validate OK, 15 tests OK | CLAUDE.md says "no PR to ship": this PR is install-only at Livio's request. Rollback UNVERIFIED. Owner: Livio |
| 10bonds | 1903978-prog/10bonds | Installed in draft PR | claude/aeos-install | validate OK, 15 tests OK | Rollback workflow contents UNVERIFIED. Owner: Livio |
| diagnostic-platform, eat-well-goal, claude-config, 1903978b-ui/anti-hacker | various | NOT enrolled | none | not inspected | Not confirmed as Eendigo applications; no changes made. `1903978b-ui/anti-hacker` looks like a second copy of Secval (different account), untouched |

Not demonstrated: automatic loading in a fresh Claude Code session; a real interrupted-session recovery inside Claude Code; any CI run of `aeos-validate.yml` (manual-only, not run, no minutes spent).
Detect un-enrolled repos: `python3 scripts/aeos/aeos.py audit <dir> <dir> ...`.
