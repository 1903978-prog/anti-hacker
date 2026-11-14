# Database Architecture & Integrity scorecard

Added 05 Nov 2026 as a new **Database** tab inside the existing secval app. Nothing else was replaced.

## Where it fits (architecture map)

| Existing secval part | How the new module uses it |
|---|---|
| `server/app.ts` (Express, `apiAuth`, rate limit, `noStore`) | New routes `/api/dbarch/*` sit behind the same token/cookie auth. |
| Refresh button (`POST /api/dashboard/check-now`) | Also starts a Quick Refresh (not awaited, bounded). |
| `server/db.ts` + `migrations.ts` (SQLite) | Migration 5 adds `dbarch_scans`, `dbarch_alerts`, `dbarch_attestations` (append-only by trigger) and `dbarch_latest`. |
| `audit_log` | Every alert and human attestation is also written there. |
| Health dashboard scores (`server/health/score.ts`) | **Untouched.** The module never reads or writes `health_scores`, so existing Database / Integrity / Backup scores are not double-counted. Its Backup criterion reads Neon-side settings only. |
| `server/quality/` (data-quality engine) | Same philosophy (untested counts as 0, coverage gates the verdict); separate tables, no shared state. |
| `schedule/` timers | New in-process scheduler: Quick every 6 h, Deep every 24 h (`SECVAL_DBARCH_QUICK_HOURS`, `SECVAL_DBARCH_DEEP_HOURS`). Scheduled polling, not streaming. |
| `notify/alerts.ts` (e-mail) | **Not used.** Alerts are in-app and in the audit trail only; no e-mail is sent. |

Code: `server/dbarch/` (`readonly.ts` guard, `connect.ts`, `catalog.ts`, `inventory.ts`, `checks.ts`, `scoring.ts`, `recommendations.ts`, `engine.ts`, `store.ts`, `view.ts`, `routes.ts`, `schedule.ts`, `neon.ts`, `registry.ts`, `apps.ts`), UI in `public/dbarch.js` and the Database panel of `public/index.html`.

## Safety

- Connection strings live only in server env vars: `SECVAL_DBARCH_URL_ATLAS`, `SECVAL_DBARCH_URL_LM_OP_MODEL`, `SECVAL_DBARCH_URL_NEXUS` (use a read-only Postgres role). Never sent to the browser or logged; connection errors are reduced to a fixed label.
- Every statement must pass `assertReadOnlySql` (single SELECT/WITH, no write/DDL keyword, no locking reads) and the session is `BEGIN READ ONLY` with `default_transaction_read_only=on` and a statement timeout. Verified against a real Postgres: a DELETE through the session is refused by the server.
- Only catalog metadata is read, plus aggregate orphan counts. The one value read from a table is the newest version label of a migration ledger. No rows are stored.
- Neon API (`SECVAL_NEON_API_TOKEN`, optional) is used with GET only. Secval never changes branch protection, retention or any setting.
- Draft SQL is stored as text, linted (forward section may only add; DROP only in ROLLBACK) and has no execution path.

## Scoring (calc version `dbarch-1.1.0`)

Rules everywhere: criterion = 10 x earned / possible points; an input that cannot be measured earns 0 **and** lowers coverage; coverage 100% = VERIFIED, 50-99% = PARTIAL, below 50% = N/V (no number). Every sub-score stores its calculation, inputs and source (shown in the UI drill-down).

Architecture Quality weights: PK coverage 12, FK integrity 14, orphan rates 14, UNIQUE/CHECK 8, security and authorization 10, indexing 10, migration governance 8, backup and recovery 10, auditability 7, maintainability 7. RLS being off is not penalised; authorization needs a time-bound human review.

Remediation Readiness: seven deliverables (baseline, FK inventory, orphan analysis, correction plan, draft migrations, current/target scores, safeguards). Each is capped at 8 until an independent verification is recorded, because secval cannot prove its own output.

`_id` columns are only candidates. A column is classified (mandatory / optional / external / intentionally non-FK) only through a reviewed entry in `server/dbarch/registry.ts`; otherwise UNVERIFIED. Orphans on unclassified columns are reported but are not a verified defect.

Historical manual baselines (3.1 / 6.4 / 6.0 and the 05 Nov 2026 counts) are stored in `apps.ts` as reference only and compared against the first live scan.

## Not covered yet (labelled N/V, not guessed)

- Live values: the build sandbox cannot reach Neon, so nothing was measured against the real databases. All numbers shown in screenshots come from fixtures.
- Named, app-specific checks and the registry are empty until the real schemas are inspected; first live scan will list the real candidates.
- Neon branch protection / retention need `SECVAL_NEON_API_TOKEN`.
- Authorization review, restore test, independent verification need a human record (Database tab, "Record a human review").

## Deployment and rollback plan (needs written approval, not done)

1. Create a read-only Postgres role per Neon project (SELECT on public, pg_catalog access) and add the three env vars on Render.
2. Merge the PR into `integration` (Render deploys). Migration 5 only creates new tables.
3. Open the Database tab, press Deep Audit, compare against the 05 Nov 2026 counts.
Rollback: remove the three env vars (module goes quiet, values N/V) or revert the PR; the new tables are inert and can stay.

## Access setup and security review

See `docs/database-scorecard-setup.md` (click-by-click, TLS, Render secrets, one-click "Test connections"), `docs/sql/dbarch-monitor-role.sql` and `docs/database-scorecard-security-review.md`.
