# Central audit register (Secval = independent auditor)

Owner rules (Livio, 07 Nov 2026): each app's own session writes its code; Secval audits read-only, files one canonical issue in the owning repo, and verifies fixes. Production merge/deploy needs Livio's explicit approval per release.

| App | Code owner (thread) | Database-score PR | State (07 Nov 03:00 UTC) | Verified by Secval |
|---|---|---|---|---|
| Secval | Secval thread | anti-hacker #48 | merged 52fd0dc, live (`/health/store` schemaVersion 5, 01:47 UTC) | VERIFIED |
| compplan | compplan thread | #699 (merged a9d26f7), #700 (draft) | production = 79e4bb7 per #700; master blocked by Release gate | PARTIAL, see A-CP-700 |
| Nexus | Nexus thread | nexus-eendigo #206 | live 36814df (`/api/version`, checked by Secval 03:05 UTC) | VERIFIED (deploy only; db-health off until secrets) |
| lm-op-model | lm-op-model thread | #841 | owner waiting to release after #48 | UNVERIFIED |
| 10bonds | 10bonds thread | #496 | owner waiting to release after #48 | UNVERIFIED |

All four apps need Livio's secrets (`/mnt/project-files/secval-release/secrets-to-set.md`) before Secval can measure them.

## Findings
| ID | App | Sev | Finding | Canonical issue | Owner | Status |
|---|---|---|---|---|---|---|
| A-CP-700-F1 | compplan | P1 | master a9d26f7 failed the Release gate (NOT APPROVED, run 42326054445); #700's manual-deploy step would bypass it | compplan#705 | compplan thread | RESOLVED 07 Nov 03:10: #700 body now routes through approval manifest + gate (checked by Secval) |
| A-CP-700-F2 | compplan | P2 | no automatic checks on PR #700 (0 check runs) | compplan#705 | compplan thread | ADDRESSED: owner evidence doc + reviewer PASS WITH NOTES; Secval re-run agrees (only F3 red). Still 0 GitHub checks |
| A-CP-700-F3 | compplan | P2 | routeAuthInventory test red: `post /api/lenovo-selftest` not listed (guarded by header secret) | compplan#705 | compplan thread | FIXED on integration 6d6dffb (Secval re-ran: 8/8 pass). NOT in #700 head 7cbeb86, so the release candidate still carries the red test (same as production today) |

Passed for A-CP-700: deal-detail panel preserved (diff identical to 79e4bb7); Secval integration on master (22/22 tests); migration 241 = 2 idempotent NOT VALID CHECKs.
Evidence log: Secval session re-ran `vitest` on #700 head 7cbeb86: 69 passed, 1 failed (F3), 9 skipped (DB tests need a database).

Secval side: `server/lenovo/check.ts` now treats HTTP 401 like 403 (token differs), because compplan answers 401 since 6d6dffb; regression test in `test/lenovo.test.ts` (fails without the fix).

## Database score rule change and deficits by app (07 Nov 2026, 15:45 UTC)

Secval PR #50 (draft, 6f77b6c, not merged): the foreign-key rule now scores coverage, and every check carries a separate integrity verdict. Apps should add `tablesInLinks` to `/api/secval/db-health` (reference SQL in `docs/database-check.md`).

Expected impact of the rule from Livio's figures (projections; real scores are UNVERIFIED until "Check all apps now" runs with the secrets set):

| ID | App (owner thread) | Deficit | Expected links points | Action owner |
|---|---|---|---|---|
| A-DB-01 | compplan / ATLAS | 3 FKs for 407 tables | 0/10, verdict at least CONCERNS | compplan thread |
| A-DB-02 | lm-op-model | 52 FKs for 193 tables; `bonds_pre_master`, `ingredients_backup_20260824` have no PK (ownership review first, no change before it) | about 3/10, PK 10/10 rounded | lm-op-model thread |
| A-DB-03 | Nexus | 126 FKs for 160 tables | about 8/10 | Nexus thread |
| A-DB-04 | 10bonds | 1 table | 10/10 | none on links |
| A-DB-05 | all four | must report `tablesInLinks` | n/a | each app thread |
| A-DB-06 | compplan, lm-op-model, Nexus | Neon point-in-time history only 6 h (10bonds 24 h) | not scored; recovery-window risk | Livio decision (Neon plan) |
| A-DB-07 | compplan | PR #700 merged, Render auto-deploy off: DB changes not proven live | n/a | compplan thread + Livio release |

Status of every row: OPEN. Measured scores and the ten rule results per app go here once the check runs.
