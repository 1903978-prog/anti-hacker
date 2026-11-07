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
