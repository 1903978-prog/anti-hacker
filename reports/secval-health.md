# secval health report (2026-10-18)

App: secval.onrender.com. Rated from the code (1903978-prog/anti-hacker, integration, commit d7d109c) and what was checked in this thread. Everything here is an **estimate**, and anything not checked is marked "not verified".

| Area | Score | Why |
|---|---|---|
| Security & Access Control | ~90 | Checked in code and tests: every API call, reads included, needs the secret token (compared in constant time; refused if none is configured). The web page signs in once and gets an HttpOnly, Secure, SameSite=Strict cookie, and changes made with that cookie must come from secval's own page. Wrong tokens are capped at 10 a minute across all callers, while the right token always works. Plus a 120/min rate limit, strict headers and CSP, a fail-closed policy gate before every scan, an append-only audit trail and a kill switch. Held back: one owner token rather than named accounts with two-step login. |
| Data Protection & Privacy | ~90 | Scans keep only findings, never site data. The allowlist, audit trail, scans and dashboard need sign-in, API answers are marked not to be cached, and the token is no longer stored in the browser (page scripts cannot read the sign-in cookie). Held back: domains waiting for proof are remembered in browser storage, and the Backblaze backup is not verified. |
| Data Integrity & Consistency | ~75 | Input is validated (zod), multi-row writes use transactions, and database triggers block edits to the audit log. Held back: there are no schema migrations, so a new column on an existing table would not appear on an old database. |
| Data Persistence & Recovery | ~35 | The free Render tier wipes the database on sleep or redeploy. The Litestream to Backblaze backup is coded and its 4 settings are in Render, but a backup and restore has never been verified. Ownership proofs were lost before. |
| Functional Completeness | ~70 | Allowlist, ownership proof, passive and active scans, the weekly sweep and the health dashboard (table, paste box, infrastructure) all exist. Missing: automatic report loading, automatic usage data, user login. |
| User Experience & Interface | ~72 | One page with no pop-ups. The dashboard table was checked at desktop and phone width (390 px) with sample data. Held back: one long page, and the phone needs sideways scrolling for the table. |
| Performance & Scalability | ~60 | One instance with SQLite and an in-memory rate limit. That's fine for one user. Free-tier cold starts are slow (time not measured). |
| Reliability & Error Handling | ~60 | Scheduler and uptime errors are caught so they never crash the server. Held back: the timers run inside the app, so when the free tier sleeps the weekly scan and uptime checks stop. The UptimeRobot pinger that keeps it awake is not verified. |
| Code Quality & Maintainability | ~80 | Type check is clean, 98 of 98 tests pass locally, and the modules are small, each with one job. |
| Deployment & Operational Readiness | ~45 | No CI runs (PR #6 had 0 checks). There are two GitHub copies, and Render builds from the old one, so changes have to be copied by hand. |

Hosted on: Render (free plan)
Deploys via: Render auto-build from GitHub 1903978b-ui/anti-hacker, branch integration (per Livio's Render screenshot; to move to 1903978-prog)
Who ships it: Render (builds on Render)
Database: SQLite file (better-sqlite3), backup by Litestream to Backblaze B2 bucket secval-backup-livio (backup not verified)
Code repository: 1903978-prog/anti-hacker (source of truth); 1903978b-ui/anti-hacker (deploy copy, to retire)
Usage (last week): not measured
