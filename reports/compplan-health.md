# compplan — health report

**App:** compplan (Eendigo ATLAS platform) · **Date:** 18/10/2026 · **Commit examined:** master `c526cd05` (PR #53); integration `f9d69dab` is 4 commits ahead (fix/neon-sleep, in-app cross-monitor).
**Evidence available:** the repo at origin/master (read with `git show`), and the GitHub Actions API (runs since 11/10/2026, two failed job logs). **Not available:** the live site compplan.onrender.com (blocked by this sandbox's proxy), Render dashboard, Neon console, billing. No test suite was run here.

## Scores

| # | Criterion | Score | Reason (evidence) |
|---|---|---|---|
| 1 | Security & Access Control | 75 | `server/auth.ts`: signed per-login session token, `timingSafeEqual`, fails closed (503) without APP_PASSWORD; `server/loginLockout.ts` (3 wrong = 1 min, 5 = 30 min, bounded store) + `loginLockout.test.ts`, `authLockout.test.ts`; `server/security.ts`: enforced CSP `script-src 'self'` (styles keep `'unsafe-inline'`), TRACE blocked, `/api` no-store, `/uploads` behind `requireAuth` (`server/index.ts:70`). 434 of 455 route lines in routes.ts name `requireAuth` (rest not reviewed). Live headers not re-checked; the proxy-hop count for the lockout key is marked UNVERIFIED in CLAUDE.md. |
| 2 | Data Protection & Privacy | 60 | Estimate, updated 18/10/2026 16:10 UTC. NOT DEPLOYED: production still serves the older version `68740a6` (PR #55), found from Livio's PC ~16:05 UTC; the 'One master database per topic' thread is fixing the Render deploy. So the live score stays at the pre-fix 60. Merged on master but waiting for deploy (PRs #56-#63, master `7a53c4c`; expected ~90 once live, not verified): Ask ATLAS sends no names or individual pay to Gemini; seed files hold only fake people; per-person export and erase (anonymise only), now also clearing names typed into task and performance-issue fields; Read.ai meetings read from the database; rejected applicants and meeting transcripts older than 12 months anonymised nightly (rows kept); old backups re-locked with the new password; no internal error text to browsers; no request bodies or e-mails in logs; 90-day cleanup of login-log personal fields. Held back: real names and pay still in git history (rewrite not done, irreversible) and the Read.ai seed file still in the code until step 2; no data-processing agreements on record. |
| 3 | Data Integrity & Consistency | 70 | Tests exist for invariants, races and concurrency (`dataInvariants`, `pricingProposalRace`, `optimisticConcurrency`, `net1CrossSurface`, `massAssignmentBreadth`); destructive-schema check script in repo. Not run here. |
| 4 | Data Persistence & Recovery | 70 | Last 7 days: Daily DB Backup 7/7 success, Daily Code Backup 7/7, Sentinel 3/3, Health Check 7/7, Shadow refresh 7/7, DR Restore Drill 1/1 (13/10). **Retained Backup Validation 5 of 6 failed**, incl. the scheduled master run 17/10 14:13 ("out of shared memory … max_locks_per_transaction"); the fix `d36ffb42` is on master but has passed only on a manual branch run, not yet on a scheduled master run. Uploaded binary files are not backed up and render.yaml declares no disk. |
| 5 | Database Design & Structure | 75 | 1 One master database: 10/10 (one Neon Postgres; the shadow and test databases are copies only); 2 No duplicated data: 5/10 (aios_cycles, deliverables and exec_logs repeat the atlas_ tables and both hold live data, per server/migrations.ts; cold_email_templates kept beside email_templates); 3 Links between records: 0/10 (only 1 enforced link in 73 tables of shared/schema.ts, plus 3 in raw SQL); 4 Unique IDs and rules: 5/10 (every table has a primary key and 404 not-null rules, but only 8 unique and 0 check rules); 5 Versioned schema changes: 10/10 (numbered migrations in server/schemaMigrations.ts run once on boot and are recorded in schema_migrations; startup tables are the baseline; db:push is no longer in the deploy and the drift check catches unknown tables); 6 Backups and proven restores: 10/10 (nightly encrypted Dropbox backup and a restore drill workflow); 7 Indexes on main lookups: 10/10 (migration 1 adds 34 indexes on the link and lookup columns: cycle, agent, employee, invoice, partner, topic ids and checklist period, on top of about 41); 8 Sensitive data protected: 5/10 (two-step login secrets encrypted, but date of birth and salary stored as plain text); 9 No secrets in code: 10/10 (DATABASE_URL comes from settings); 10 Clear naming and documented schema: 10/10 (one snake_case style; docs/DATABASE.md lists all 99 tables with columns, keys, links and indexes, generated from the code and kept current by a test) |
| 6 | UX & Interface | — | not verified (no browser check possible). |
| 7 | Performance & Scalability | — | not verified (no live measurements; neon-sleep pool changes are on integration only). |
| 8 | Reliability & Error Handling | 55 | Production login outage fixed 17/10 (PR #51, `d755b1d`: random per-process key when SESSION_SECRET missing), persistent key in PR #53. Nightly CI scheduled run 17/10 07:08 **failed** (manual re-run on 4c12dd69 passed 16:04). Old "Test" workflow: 18 of 43 runs failed in 7 days, incl. master push 51f9710b on 16/10. |
| 9 | Code Quality & Maintainability | ~68 (estimate) | Updated 18/10/2026 from integration `051dd8a`: `server/routes.ts` is now 168 lines with 20 route modules under `server/routes/` (split in PR #55); `npm run check` (tsc) has 0 errors and the baseline is empty; test files are type-checked too (1 error fixed; merged to master via PR #59, 18/10/2026). Still large: 4 client pages over 4,000 lines (PricingTool.tsx 8,425), `server/seed.ts` 4,635, `shared/schema.ts` 1,973 lines; 50 test files. Score is an estimate. |
| 10 | Deployment & Operational Readiness | 70 | render.yaml: Render auto-deploy of `master`, `preDeployCommand: node scripts/neon-deploy-snapshot.mjs` (aborts deploy on failure); `scripts/ship-check.mjs` (+ test) waits for the commit, watches `/api/health/db` 10 min and rolls back via Render API. render.yaml records two past disagreements with the dashboard; rollback never shown live here; plan/region not in render.yaml. |

**Overall: 68 / 100** — average of the 7 scored criteria (3 not verified). Privacy updated 18/10/2026 (estimate).

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
