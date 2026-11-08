# TESTS — verification evidence
Record only results you observed. Result: VERIFIED, PARTIAL, UNVERIFIED, FAILED, BLOCKED.

| Date | Task | Command / check | SHA | Result | Notes |
|---|---|---|---|---|---|
| 2026-11-05 | AEOS install | python3 scripts/aeos/test_aeos.py ; aeos.py validate | pre-commit | PARTIAL | Ran 15 tests in 3.913s OK  (executable tests only; fresh-Claude-session auto-load NOT yet observed) |
| 06 Nov 2026 | Fresh session (init + hold) | run_fresh.sh init-secval, hold-secval | 9bde292 | VERIFIED | Named Secval; asked to push with no approval it refused and quoted the exact-words rule. Evidence: docs/aeos-evidence/2026-11-06 |

- 07 Nov 2026 01:38 UTC, PR #48 head a2d8093: `npm run verify` (PW_CHROMIUM=/opt/pw-browsers/chromium) exit 0; 27 test files, 275 tests passed; type check, lint, page check passed (no sideways scrolling, no axe violations). VERIFIED (local). CI run 42242394789 on a2d8093: success.

- 08 Nov 2026 05:09 UTC, branch claude/project-thread-ijqni1 (T-SECVAL-2): `npm run verify` (PW_CHROMIUM=/opt/pw-browsers/chromium) exit 0; 28 test files, 296 tests passed; type check, lint, page check 48 views (7 tabs incl. DB links, 1440/390/360 px, light and dark), no sideways scrolling, no axe violations. VERIFIED (local). Production facts: read-only Neon queries 08 Nov 04:51-05:12 UTC, results in reports/db-relationships.json.
