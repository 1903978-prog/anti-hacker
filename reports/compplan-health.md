# compplan — health report

**App:** compplan (Eendigo ATLAS platform) · **Date:** 18/10/2026 · **Commit examined:** master `c526cd05` (PR #53); integration `f9d69dab` is 4 commits ahead (fix/neon-sleep, in-app cross-monitor).
**Evidence available:** the repo at origin/master (read with `git show`), and the GitHub Actions API (runs since 11/10/2026, two failed job logs). **Not available:** the live site compplan.onrender.com (blocked by this sandbox's proxy), Render dashboard, Neon console, billing. No test suite was run here.

## Scores

| # | Criterion | Score | Reason (evidence) |
|---|---|---|---|
| 1 | Security & Access Control | 75 | `server/auth.ts`: signed per-login session token, `timingSafeEqual`, fails closed (503) without APP_PASSWORD; `server/loginLockout.ts` (3 wrong = 1 min, 5 = 30 min, bounded store) + `loginLockout.test.ts`, `authLockout.test.ts`; `server/security.ts`: enforced CSP `script-src 'self'` (styles keep `'unsafe-inline'`), TRACE blocked, `/api` no-store, `/uploads` behind `requireAuth` (`server/index.ts:70`). 434 of 455 route lines in routes.ts name `requireAuth` (rest not reviewed). Live headers not re-checked; the proxy-hop count for the lockout key is marked UNVERIFIED in CLAUDE.md. |
| 2 | Data Protection & Privacy | 60 | Backups AES-256 since 15/10 (docs/BACKUP_AND_RESTORE.md §15 Oct); no secrets in render.yaml (production sets only NODE_ENV). But one BACKUP_ZIP_PASSWORD decrypts every backup, and pre-15/10 zips stay ZipCrypto (same doc). |
| 3 | Data Integrity & Consistency | 70 | Tests exist for invariants, races and concurrency (`dataInvariants`, `pricingProposalRace`, `optimisticConcurrency`, `net1CrossSurface`, `massAssignmentBreadth`); destructive-schema check script in repo. Not run here. |
| 4 | Data Persistence & Recovery | 70 | Last 7 days: Daily DB Backup 7/7 success, Daily Code Backup 7/7, Sentinel 3/3, Health Check 7/7, Shadow refresh 7/7, DR Restore Drill 1/1 (13/10). **Retained Backup Validation 5 of 6 failed**, incl. the scheduled master run 17/10 14:13 ("out of shared memory … max_locks_per_transaction"); the fix `d36ffb42` is on master but has passed only on a manual branch run, not yet on a scheduled master run. Uploaded binary files are not backed up and render.yaml declares no disk. |
| 5 | Functional Completeness | — | not verified (live site unreachable; no page loaded). |
| 6 | UX & Interface | — | not verified (no browser check possible). |
| 7 | Performance & Scalability | — | not verified (no live measurements; neon-sleep pool changes are on integration only). |
| 8 | Reliability & Error Handling | 55 | Production login outage fixed 17/10 (PR #51, `d755b1d`: random per-process key when SESSION_SECRET missing), persistent key in PR #53. Nightly CI scheduled run 17/10 07:08 **failed** (manual re-run on 4c12dd69 passed 16:04). Old "Test" workflow: 18 of 43 runs failed in 7 days, incl. master push 51f9710b on 16/10. |
| 9 | Code Quality & Maintainability | 55 | `server/routes.ts` is 13,369 lines; `shared/schema.ts` 103 KB; 16 known tsc errors in `scripts/lanes/tsc-baseline.txt` (routes.ts, BdSignals, Hiring, Checklist); 49 test files on master. |
| 10 | Deployment & Operational Readiness | 70 | render.yaml: Render auto-deploy of `master`, `preDeployCommand: node scripts/neon-deploy-snapshot.mjs` (aborts deploy on failure); `scripts/ship-check.mjs` (+ test) waits for the commit, watches `/api/health/db` 10 min and rolls back via Render API. render.yaml records two past disagreements with the dashboard; rollback never shown live here; plan/region not in render.yaml. |

**Overall: 65 / 100** — average of the 7 scored criteria (3 not verified).

## Infrastructure

- **Live URL:** compplan.onrender.com (not reachable from here; not verified that it is up).
- **Host:** Render web service `compplan` (runtime node, `npm run build` / `npm start`). Plan and region are **not stated in render.yaml** — not verified.
- **Test copy:** Render service `compplan-test`, deploys `integration`, own free Render Postgres `compplan-test-db` (database `compplan_test`, deleted by Render after 30 days per the file's own note). Whether Render actually created it: not verified.
- **Database:** Neon PostgreSQL (docs/SETUP.md line 44: 98 tables as of 21/09/2026); shadow branch `br-flat-field-a4sgtbdh`. No production database/project name is in the repo; Neon plan and PITR window not verified (SETUP.md says to check the console).
- **Repo / branches:** GitHub 1903978-prog/compplan; `master` deploys, `integration` accumulates.
- **Who deploys:** Render itself on merge to master (no GitHub workflow deploys — `.github/workflows` has none), Neon snapshot before go-live.
- **Workflow runs since 11/10/2026** (132 runs; wall-clock minutes from run_started_at to updated_at — NOT billed minutes; billing is not readable from here):

| Workflow | Runs | Wall-clock min | Conclusions |
|---|---|---|---|
| Test (old per-PR/push; replaced 16/10) | 43 | 61.6 | 25 ok, 18 fail |
| Retained Backup Validation | 6 | 18.5 | 1 ok, 5 fail |
| Daily DB Backup | 7 | 7.7 | 7 ok |
| Data Protection Health Check | 7 | 6.8 | 7 ok |
| Nightly CI | 2 | 5.8 | 1 ok, 1 fail |
| Shadow Database Refresh | 7 | 5.6 | 7 ok |
| Notify on scheduled backup failure | 40 | 2.5 | 34 skipped, 6 ok |
| DR Restore Drill | 1 | 2.3 | 1 ok |
| Daily Code Backup | 7 | 2.0 | 7 ok |
| One-off archive retired-app backups (2 names) | 9 | 1.3 | 3 ok, 6 fail |
| Backup Liveness Sentinel | 3 | 1.1 | 3 ok |
| **Total** | **132** | **114.9** | |

- **Render resource usage and Render build minutes:** not visible (no Render access).
- The 18/10 02:30 UTC Nightly CI had not run yet at 03:32 UTC (no run listed).

## The 3 biggest gaps

1. **Backup validation is red on master.** Retained Backup Validation failed on its scheduled master run 17/10 (log: "out of shared memory … increase max_locks_per_transaction" during restore), and 4 more runs that day failed. The fix (`d36ffb42`) passed once on a manual branch run and is on master, but no scheduled master run has passed yet — so whether old retained backups restore is not proven. The weekly DR drill passed once (13/10).
2. **Auth/reliability regressions reach production.** A login outage hit production on 17/10 (fixed by PR #51, then PR #53), the scheduled Nightly CI failed the same day, and 18 of 43 old Test runs failed in the week; CI is now nightly-only, so a broken change is caught after it merges, not before.
3. **Uploaded files are not protected.** docs/BACKUP_AND_RESTORE.md says knowledge/KM uploads are written to `uploads/` on the Render instance and are in no backup; render.yaml declares no persistent disk — so those files can be lost on any redeploy/restart (not verified live). Also a single BACKUP_ZIP_PASSWORD guards every backup.
