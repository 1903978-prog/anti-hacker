# AEOS compliance register

Generated from `reports/aeos-compliance.json` (collected 2026-11-06T09:24:09Z, not live). Regenerate with `python3 scripts/aeos/register.py`; `test/aeos-register.test.ts` fails if this file and the data disagree.

Score basis (out of 100): installed 20, validate ok 25, own tests pass 20, fresh session evidence 15, draft pr open and mergeable 10, no open p0 p1 or blockers 10. It measures AEOS installation and proof, not application quality.

| Application | Repository | AEOS | Validation | AEOS tests | Tasks (verified / not) | Open P0/P1 | Pull request | Fresh-session tests | Score |
|---|---|---|---|---|---|---|---|---|---|
| Secval | 1903978-prog/anti-hacker | 1.0.0 | passed | 22 ran, passed | 0 / 0 | 0 | [#47](https://github.com/1903978-prog/anti-hacker/pull/47) draft, head 9bde292 | 2 of 2 | **100** |
| Nexus | 1903978-prog/nexus-eendigo | 1.0.0 | passed | 22 ran, passed | 0 / 0 | 0 | [#195](https://github.com/1903978-prog/nexus-eendigo/pull/195) draft, head e418eb8 | 2 of 2 | **100** |
| Eendigo ATLAS / CompPlan | 1903978-prog/compplan | 1.0.0 | passed | 22 ran, passed | 0 / 0 | 0 | [#690](https://github.com/1903978-prog/compplan/pull/690) draft, head dbbf89f | 1 of 1 | **100** |
| LM OpModel | 1903978-prog/lm-op-model | 1.0.0 | passed | 22 ran, passed | 0 / 0 | 0 | [#831](https://github.com/1903978-prog/lm-op-model/pull/831) draft, head add6e4f | 2 of 2 | **100** |
| 10bonds | 1903978-prog/10bonds | 1.0.0 | passed | 22 ran, passed | 0 / 0 | 0 | [#494](https://github.com/1903978-prog/10bonds/pull/494) draft, head d31f76b | 1 of 1 | **100** |

## Not verified, per application (owner: Livio unless stated)

- **Secval**: live Render service state and auto-deploy setting; B2 bucket contents and last restore test
- **Nexus**: live Fly machine state; whether render.yaml service still exists on Render
- **Eendigo ATLAS / CompPlan**: live Render dashboard auto-deploy setting (render.yaml and dashboard have disagreed before, per CLAUDE.md); RENDER_API_KEY presence
- **LM OpModel**: live Fly machine state; whether rollback-on-smoke-failure has ever fired for real (CLAUDE.md says it had not as of 13 Oct 2026)
- **10bonds**: live Fly machine state; FLY_API_TOKEN secret presence

## Approvals still needed (none given)

- **Secval**: merge of the install PR; any production deploy; confirmation of UNVERIFIED items
- **Nexus**: merge of the install PR; any production deploy; confirmation of UNVERIFIED items
- **Eendigo ATLAS / CompPlan**: merge of the install PR; any production deploy; confirmation of UNVERIFIED items
- **LM OpModel**: merge of the install PR; any production deploy; confirmation of UNVERIFIED items
- **10bonds**: merge of the install PR; any production deploy; confirmation of UNVERIFIED items

## Not enrolled

- `1903978-prog/diagnostic-platform`: fork; not confirmed as an Eendigo application
- `1903978-prog/eat-well-goal`: personal project; not confirmed as an Eendigo application
- `1903978-prog/claude-config`: configuration repository; proposed home for the central AEOS package (needs Livio's decision)
- `1903978b-ui/anti-hacker`: other account; looks like a second copy of Secval; untouched

Detect un-enrolled repositories: `python3 scripts/aeos/aeos.py audit <dir> <dir> ...`.
