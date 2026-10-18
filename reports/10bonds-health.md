# 10bonds health report

Checked 18/10/2026 12:30 UTC by the 10bonds thread. **All scores are estimates (E)** from reading the code on `main` (commit `11115f8`, 18/10 12:23 UTC). No live data was touched.

Sources I read myself:
- the whole repo `1903978-prog/10bonds` (33 files, about 1,000 lines);
- `npm test` (13 of 13 pass), `tsc --noEmit` (0 errors) and `npm audit` (1 high, 1 moderate), run here on that commit.

I could not open the live site from here: this workspace's network blocks 10bonds.com and fly.dev. So no live headers, TLS or page speed were checked.

## Scores

| # | Area | Score | Reason (evidence) |
|---|---|---|---|
| 1 | Security & Access Control | ~75 (estimate) | Updated 18/10/2026 16:05 UTC. Browser safety headers now sent on every page (10bonds PR #6: CSP limited to the site's own address, HSTS, nosniff, no framing, referrer and permissions rules, cross-origin isolation); checked in a headless browser with no CSP errors. secval's passive scan of 10bonds.fly.dev before this change found 12 header findings; 10 should clear, the Server and Via headers come from Fly's proxy and stay. Since the first report the site gained accounts, sign-up with a robot check, Stripe and an admin page: those were not reviewed in depth here. Still open: CSP allows inline scripts (Next.js needs them), no rate limit seen on the bond search, `npm audit` high issue in Next's bundled postcss. Live headers not re-scanned yet. |
| 2 | Data Protection & Privacy | ~85 (estimate) | The site stores no personal data: no accounts, no forms, no cookies, no analytics in the code. Gap: no privacy policy page yet (the disclaimer says it will come before paid plans open). |
| 3 | Data Integrity & Consistency | ~75 (estimate) | Reads only bonds with a yield, a duration, a future maturity and currency EUR. Sample data is clearly labelled and only allowed in production when `ALLOW_SAMPLE_DATA=1`. The "yields as of" date is shown. Gaps: nothing warns if the daily copy stops updating (old yields would show quietly); no check that the table's columns still match. |
| 4 | Data Persistence & Recovery | ~70 (estimate) | The site keeps no data of its own. Its one table is a copy that lm-op-model rebuilds every day, so recovery means re-running that copy. Not verified: Neon backups for this database and whether the daily copy is running. |
| 5 | Database Design & Structure | 80 | 1 One master database: 10/10 (the master is lm-op-model; this is a documented read-only copy); 2 No duplicated data: 10/10 (one deliberate, documented copy table); 3 Links between records: 10/10 (only one table, nothing to link); 4 Unique IDs and rules: 5/10 (the table is created by lm-op-model, its keys and rules are not visible here); 5 Versioned schema changes: 5/10 (`db/setup.sql` is run by hand; the table design lives in lm-op-model); 6 Backups and proven restores: 5/10 (rebuilt daily from the master, but no restore tested here); 7 Indexes on main lookups: 5/10 (not visible; the site reads the whole table once an hour, so low impact); 8 Sensitive data protected: 10/10 (no personal data, read-only login); 9 No secrets in code: 10/10 (`DATABASE_URL` comes from settings and GitHub secrets); 10 Clear naming and documented schema: 10/10 (columns documented in `lib/types.ts` and the README). Estimate. |
| 6 | UX & Interface | ~75 (estimate) | From the code: two sliders, a clear top 10 table, phone layout with cards, labels on sliders, disclaimers on every page. Gaps: no way to type an exact number; pricing buttons say "Coming soon". Not checked in a browser. |
| 7 | Performance & Scalability | ~70 (estimate) | Bond list cached in memory for 1 hour; ranking is done in memory on a small list. Gap: the machine stops when idle (`min_machines_running = 0` in `fly.toml`), so the first visitor after a quiet spell waits for a cold start. Not measured live. |
| 8 | Reliability & Error Handling | ~65 (estimate) | A database failure gives a friendly "try again later" message (503). Gaps: the health check never touches the database, so a broken database connection would not be flagged; when the 1-hour cache runs out and the database fails, the site shows an error instead of the last good list; one machine only (`--ha=false`). |
| 9 | Code Quality & Maintainability | ~80 (estimate) | Small and tidy (about 1,000 lines), strict TypeScript with 0 errors, 13 tests passing (ranking, ratings, paid-field hiding, issuer clean-up), clear comments. Gaps: no tests for the web route or the page; no lint step. |
| 10 | Deployment & Operational Readiness | ~65 (estimate) | Every push to `main` deploys to Fly automatically (`.github/workflows/deploy.yml`) and stops safely if the Fly token is missing. Gaps: tests do not run before a deploy; deploy action not pinned; no rollback step; one machine. 10bonds.com is not connected to anything (checked 18/10 15:05 UTC). |

## Infrastructure (from the code; not checked live)

- **Live URL:** https://10bonds.fly.dev. The name 10bonds.com does not exist on the internet (Livio's browser: DNS_PROBE_FINISHED_NXDOMAIN, 18/10 15:05 UTC).
- **Host:** Fly.io, app `10bonds`, region cdg (Paris), one shared machine with 512 MB that stops when idle. Source: fly.toml.
- **Database:** its own Neon Postgres, one table `public_bonds`, read with the `tenbonds_reader` login. Filled daily by lm-op-model.
- **GitHub:** repo `1903978-prog/10bonds` (public), branch `main`; pushing to `main` deploys.
- **Secval ownership:** not proven yet, so no measured scan has run. 10bonds.com cannot be proven (the name does not exist); 10bonds.fly.dev serves the proof file and needs its own row and code in secval.

## 3 biggest gaps

1. **New account and payment code not yet reviewed in depth** (sign-up, Stripe, admin page), and no request limit seen on the bond search. Security headers were added 18/10 (PR #6).
2. **Quiet failure modes:** stale yields or a broken database link would not raise any alarm.
3. **Deploys skip the tests** and use an unpinned deploy tool.
