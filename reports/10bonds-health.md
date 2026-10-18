# 10bonds health report

Updated 18/10/2026 16:20 UTC after 10bonds PR #7 (tests before deploy, rollback button, error pages, bond search limit). Rows 1, 2, 8, 9 and 10 re-scored; still estimates.

Checked 18/10/2026 12:30 UTC by the 10bonds thread. **All scores are estimates (E)** from reading the code on `main` (commit `11115f8`, 18/10 12:23 UTC). No live data was touched.

Sources I read myself:
- the whole repo `1903978-prog/10bonds` (33 files, about 1,000 lines);
- `npm test` (13 of 13 pass), `tsc --noEmit` (0 errors) and `npm audit` (1 high, 1 moderate), run here on that commit.

I could not open the live site from here: this workspace's network blocks 10bonds.com and fly.dev. So no live headers, TLS or page speed were checked.

## Scores

| # | Area | Score | Reason (evidence) |
|---|---|---|---|
| 1 | Security & Access Control | ~80 (estimate) | Browser safety headers on every page (PR #6). Login limited to 10 tries per 15 min per address and per email (existing code). Bond search and curve now limited to 240 requests a minute per address (PR #7, checked locally: request 241 gets 429). Still open: CSP allows inline scripts (Next.js needs them); Server/Via headers come from Fly's proxy; account, Stripe and admin code not reviewed in depth; limits are per machine (one machine today). Live headers not re-scanned. |
| 2 | Data Protection & Privacy | ~70 (estimate) | Re-scored 18/10 16:20 UTC: the site now has accounts (email + password), sign-up, Stripe payments and an admin page, so it stores personal data. Passwords are not stored in plain text and login cookies are used (not reviewed in depth). Gap: no privacy policy page yet (needs Livio's wording, not written by code). |
| 3 | Data Integrity & Consistency | ~75 (estimate) | Reads only bonds with a yield, a duration, a future maturity and currency EUR. Sample data is clearly labelled and only allowed in production when `ALLOW_SAMPLE_DATA=1`. The "yields as of" date is shown. Gaps: nothing warns if the daily copy stops updating (old yields would show quietly); no check that the table's columns still match. |
| 4 | Data Persistence & Recovery | ~70 (estimate) | The site keeps no data of its own. Its one table is a copy that lm-op-model rebuilds every day, so recovery means re-running that copy. Not verified: Neon backups for this database and whether the daily copy is running. |
| 5 | Database Design & Structure | 80 | 1 One master database: 10/10 (the master is lm-op-model; this is a documented read-only copy); 2 No duplicated data: 10/10 (one deliberate, documented copy table); 3 Links between records: 10/10 (only one table, nothing to link); 4 Unique IDs and rules: 5/10 (the table is created by lm-op-model, its keys and rules are not visible here); 5 Versioned schema changes: 5/10 (`db/setup.sql` is run by hand; the table design lives in lm-op-model); 6 Backups and proven restores: 5/10 (rebuilt daily from the master, but no restore tested here); 7 Indexes on main lookups: 5/10 (not visible; the site reads the whole table once an hour, so low impact); 8 Sensitive data protected: 10/10 (no personal data, read-only login); 9 No secrets in code: 10/10 (`DATABASE_URL` comes from settings and GitHub secrets); 10 Clear naming and documented schema: 10/10 (columns documented in `lib/types.ts` and the README). Estimate. |
| 6 | UX & Interface | ~75 (estimate) | From the code: two sliders, a clear top 10 table, phone layout with cards, labels on sliders, disclaimers on every page. Gaps: no way to type an exact number; pricing buttons say "Coming soon". Not checked in a browser. |
| 7 | Performance & Scalability | ~70 (estimate) | Bond list cached in memory for 1 hour; ranking is done in memory on a small list. Gap: the machine stops when idle (`min_machines_running = 0` in `fly.toml`), so the first visitor after a quiet spell waits for a cold start. Not measured live. |
| 8 | Reliability & Error Handling | ~75 (estimate) | Database failure gives a friendly 503. New (PR #7): a page error shows a 'Something went wrong / Try again' page instead of a blank one, unknown links show a 10BONDS 'Page not found' page (checked locally), and request floods get 429 instead of loading the database. Health checks for accounts, billing and ranking run after each deploy. Gaps: one machine only (`--ha=false`); stale yields still raise no alarm. |
| 9 | Code Quality & Maintainability | ~82 (estimate) | Strict TypeScript with 0 errors, 70 tests passing (18/10 16:10 UTC, local run), and the tests now run in CI before every deploy. Operations written down in `docs/OPERATIONS.md`. Gaps: no lint step; no tests for pages. |
| 10 | Deployment & Operational Readiness | ~80 (estimate) | Every push to `main` runs type check + tests first; the deploy only happens if they pass, then post-deploy checks run (site, accounts DB, robot check, payments, ranking). One-click rollback: Actions > 'Roll back to the previous release' redeploys the previous Fly image (PR #7; not yet run, so not verified). Gaps: deploy action not pinned to a version; one machine. |

## Infrastructure (from the code; not checked live)

- **Live URL:** https://10bonds.fly.dev. The name 10bonds.com does not exist on the internet (Livio's browser: DNS_PROBE_FINISHED_NXDOMAIN, 18/10 15:05 UTC).
- **Host:** Fly.io, app `10bonds`, region cdg (Paris), one shared machine with 512 MB that stops when idle. Source: fly.toml.
- **Database:** its own Neon Postgres, one table `public_bonds`, read with the `tenbonds_reader` login. Filled daily by lm-op-model.
- **GitHub:** repo `1903978-prog/10bonds` (public), branch `main`; pushing to `main` deploys.
- **Secval ownership:** 10bonds.fly.dev proven 18/10 15:57 UTC (Livio's screenshot). 10bonds.com cannot be proven (the name does not exist); its old row can be removed.

## 3 biggest gaps

1. **Account, payment and admin code not reviewed in depth** (sign-up, Stripe, admin page).
2. **Quiet failure mode:** stale yields (the daily copy stopping) raise no alarm.
3. **One machine, no separate backup:** if Neon's short restore window passes, there is no independent copy of the accounts database (a free nightly dump is possible later).
