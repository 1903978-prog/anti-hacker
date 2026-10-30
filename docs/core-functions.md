# Core functions and their fast checks (Rule 2)

Run in one go (under 2 minutes): `npx vitest run test/policy.test.ts test/ownership.test.ts test/scan.test.ts test/audit.test.ts test/backup.test.ts test/app.test.ts`, plus the URL check on production.

| # | Core function | Fast check |
|---|---|---|
| 1 | Policy engine approves or denies every scan action, fails closed | `test/policy.test.ts` |
| 2 | Ownership allowlist: only proven domains can be scanned | `test/ownership.test.ts` |
| 3 | Kill switch stops all scans | `test/policy.test.ts`, `test/app.test.ts` |
| 4 | Scan resource caps abort over-limit scans | `test/scan.test.ts` |
| 5 | Passive scan and findings catalogue | `test/scan.test.ts`, `test/catalogue.test.ts`, `test/checks.test.ts` |
| 6 | Active scan only for active-eligible domains | `test/active.test.ts` |
| 7 | Append-only audit log | `test/audit.test.ts` |
| 8 | Sign-in / API token gate and rate limit | `test/app.test.ts` |
| 9 | Backup, restore drill, Dropbox check | `test/backup.test.ts`, `test/dropbox.test.ts` |
| 10 | Store integrity and migrations | `test/integrity.test.ts`, `test/migrations.test.ts` |
| 11 | Rollback of an app deploy | `test/rollback.test.ts` |
| 12 | Weekly schedule runs | `test/schedule.test.ts` |
| 13 | Health scores, CI cap, uptime | `test/score.test.ts`, `test/health.test.ts`, `test/ci.test.ts` |
| 14 | Alerts and daily digest | `test/alerts.test.ts`, `test/daily.test.ts` |
| 15 | Usage tab (costs per app) | `test/usage.test.ts` |
| 16 | Dashboard pages render | `npm run test:page` (needs Chromium) |
| 17 | App is up on production | open https://secval.onrender.com/health, expect ok |
