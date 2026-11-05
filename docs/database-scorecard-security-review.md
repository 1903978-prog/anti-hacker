# Security review: database scorecard (PR #45), 05 Nov 2026

Reviewer: the build session itself plus tests. This is NOT an independent penetration test.

| Risk | Control | Evidence |
|---|---|---|
| Secval writes to a monitored DB | Login has no write/DDL/owner/admin right (verified from the database's own `has_*_privilege`, before every scan; any failure refuses the scan and raises a P0 alert). Session is `READ ONLY`, role default `default_transaction_read_only=on`. Every statement must pass a SELECT-only guard. | Tests: write keywords rejected; real Postgres: DELETE and CREATE refused for the role; over-privileged role detected and scan refused. |
| Credentials leak | Strings only in 3 Render env vars; never returned by any API, never logged; connection errors reduced to fixed labels; password not echoed by the connectivity test. | Tests assert the password and `fake://` strings never appear in any response. |
| Plaintext connection | Remote host without `sslmode=require` is refused; certificate verified (`rejectUnauthorized`). Loopback only exempt. | Unit tests; connectivity stage "TLS required". |
| SQL injection | No user input reaches SQL. Identifiers come from the catalog, must match `^[A-Za-z_][A-Za-z0-9_$]*$` and are double-quoted. | `ident()` in `readonly.ts`. |
| Data exposure | Only catalog metadata and aggregate counts are read/stored; one migration version label is read. Findings hold table/column names, never row values. | Code review of `catalog.ts`, `checks.ts`. |
| Runaway load | Statement timeout 10 s, lock timeout 2 s, check budgets (quick 12 checks, deep 250), size cap on tables, total time cap (60 s / 300 s), one scan per app at a time, 60 s dedupe. | Tests: budget skip and dedupe. The total-time cap is code-reviewed only (no test). |
| Unauthorized use of the tab | Same token/cookie auth and rate limit as the rest of secval; attestations are time-bound and append-only. | HTTP tests (401 without token). |
| Alerts leaking by e-mail | Module sends no e-mail; alerts are in-app and the audit trail. | Code review. |

Residual risks (accepted until you decide otherwise):
1. The login can SELECT every public table. A compromise of the secval server or the Render account would expose that read access. Mitigation: optional column-level grants (setup doc), 3-connection limit, rotate the password by `ALTER ROLE secval_monitor PASSWORD '...'`.
2. TLS reporting uses `pg_stat_ssl`, which can read "unknown" through a pooler; the client-side TLS requirement is the real control.
3. Not verified against the real Neon databases or from Render yet.

## Rollback

- Fastest: delete the three `SECVAL_DBARCH_URL_*` variables on Render. The tab shows N/V and nothing connects.
- Per database: `DROP OWNED BY secval_monitor; DROP ROLE secval_monitor;` in the Neon SQL Editor.
- Code: revert PR #45. Migration 5 only added four new tables; they are inert if left.

## GO / NO-GO

NO-GO for merge until Livio approves the access setup and "Test connections" passes for all three databases from Render. The code itself: GO for review.
