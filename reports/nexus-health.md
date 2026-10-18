# Nexus health report

Checked 18/10/2026 03:40 UTC by the nexus thread. Only facts checked in this run are scored. Where I could not check something, the score is left blank and marked "not verified".

Sources I read myself:
- the app's own read-only production checks, run 18/10 02:35 UTC (`ops-check` and `control-check` jobs in GitHub Actions);
- the GitHub Actions run history;
- the code on `main` and `integration`.

I could not open the live site from here, because this workspace's network blocks fly.dev.

## Scores

| # | Area | Score | Reason (checked evidence) |
|---|---|---|---|
| 1 | Security & Access Control | 85 | Two-step login is enforced on production. The login lockout is live (deploy run 273). The app reads the caller's address correctly. Not higher because all 11 passwords still use the older storage method (0 of 11 moved to the newer argon2 yet), 4 accounts can't log in until they use their setup link, and there has been no outside penetration test. |
| 2 | Data Protection & Privacy | 85 | Estimate, updated 18/10/2026: PR #162 merged on master (export and erase of one person's data, no-store on API answers, 90-day cleanup, masked logs), plus later erase fixes. Earlier evidence still holds: the production check shows e-mail addresses masked, daily backups in Dropbox, code encrypts backups (AES-256). Not checked live and no backup file opened. |
| 3 | Data Integrity & Consistency | 88 | The dashboard check found 0 broken numbers on both projects. The copy database matches all 117 tables. The 17/10 restore test compared 117 tables and none were off. |
| 4 | Data Persistence & Recovery | 90 | The restore test passed on 17/10: 31,543 rows into 117 tables. Dropbox has database backups from 15, 16 and 17/10 (each about 47.5 MB). The copy database refreshed 18/10 01:00 UTC. |
| 5 | Database Design & Structure | 75 | 1 One master database: 5/10 (Neon Postgres is the master, but the Diagnostic module keeps its own users and cases in a separate Supabase database); 2 No duplicated data: 5/10 (users kept in both Neon and Supabase; unused gov_gates, gov_deliverables and gov_deliverable_levels tables beside deliverables); 3 Links between records: 5/10 (79 of 121 tables have enforced foreign keys, 96 in total, while 42 tables have none); 4 Unique IDs and rules: 5/10 (every table has a primary key, 42 unique rules, 0 check rules); 5 Versioned schema changes: 5/10 (no Alembic; about 112 hand-written ALTER TABLE statements run at startup); 6 Backups and proven restores: 10/10 (daily encrypted Dropbox backup, snapshot before each deploy, monthly restore drill); 7 Indexes on main lookups: 10/10 (182 indexes, covering the link columns); 8 Sensitive data protected: 10/10 (argon2id passwords, encrypted two-step login secrets); 9 No secrets in code: 10/10 (database and Supabase keys come from settings); 10 Clear naming and documented schema: 10/10 (one naming style with module prefixes; docs/DATABASE.md lists all 120 model tables with keys, links, rules and indexes, generated from the models and kept current by tests/test_schema_doc.py) |
| 6 | UX & Interface | (blank) | Not verified. No browser check in this run. |
| 7 | Performance & Scalability | 60 | The machine has 512 MB of memory. The app peaked at 392 to 396 MB during the 17/10 deploy restarts (production check), so there is little room left. Page speed on real data was not measured. |
| 8 | Reliability & Error Handling | 70 | The scheduler is running and no job is failing now, and e-mail sends work (0 failed in 24 h). But in the last 24 h, 3 job runs were cut off (2 copy-database refreshes, 1 backup) and the app had 2 unclean restarts (both during the 17/10 deploy). |
| 9 | Code Quality & Maintainability | 70 | About 2,970 backend tests (201 files) against about 79,000 lines of backend code. The front end has about 52,600 lines but only 8 test files. Test coverage % is not measured, and the tests run on SQLite, not Postgres. |
| 10 | Deployment & Operational Readiness | 78 | All 4 deploys on 17/10 succeeded (runs 271-274, about 2 to 2.5 minutes each). An independent review runs before each release. Gaps: deploys are started by hand, and the full test run is not wired to every deploy (one test run on main failed on 17/10 03:32, the next full run passed). |

## Infrastructure (checked unless marked)

- **Live URL:** https://nexus-eendigo.fly.dev
- **Host:** Fly.io, app `nexus-eendigo`, region iad (Virginia).
  - Source: fly.toml.
- **Plan/tier:** one always-on machine, shared-cpu-1x with 512 MB.
  - Source: fly.toml.
  - The Fly billing plan was not checked.
- **Live build:** commit eae1890, built 17/10 17:11 UTC.
  - Source: production check.
- **Database:** Neon Postgres, with a second "shadow" copy database.
  - The production check says the connection is "pooled" and finds 117 tables.
  - The database name and Neon plan were not checked; they are not visible from here.
- **Backups:** daily code and database backups to Dropbox (`/nexus/CODE`, `/nexus/DB`), run by the app itself.
  - A restore test runs at least monthly.
- **GitHub:** repo `1903978-prog/nexus-eendigo`.
  - Work merges into `integration`; `main` is what is shipped.
  - `integration` is 3 commits ahead of `main`: two security tests, documentation and this scorecard.
- **Who deploys:** a person starts the GitHub Actions "Fly Deploy" workflow by hand; it builds and deploys to Fly. Pushing to `main` does not deploy.
- **Build-minute usage, last 7 days:** not verified. Billed minutes are not visible to this session.
  - From run times: each full test run takes about 10 to 17 minutes and each deploy about 2 to 3 minutes. There were about 30 workflow runs on 17/10 alone, most of them short scheduled checks.
  - Fly compute usage: not visible.

## 3 biggest gaps

1. **Not much memory left:** the app peaks around 395 of 512 MB, and the deploy restarts were unclean. A busy moment, like several Wednesday deck builds at once, could run out.
2. **Most features have not been tested by clicking through them** (roughly 44% per the earlier estimate). The front end has very few tests, and two Diagnostic exports are broken (missing template files).
3. **Logins are not fully secured yet:**
   - 4 of 11 accounts are blocked until they use their 2FA setup link (sent 14/10; the links expire around 21/10);
   - no password has been moved to the newer storage method yet;
   - no outside security test has been run.
