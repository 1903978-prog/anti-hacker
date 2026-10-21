# lm-op-model: Personal Data in Code (20/10/2026)

Repo 1903978-prog/lm-op-model (private). Today's code = branch integration (master is behind: its CLAUDE.md still has the old personal notes). History: all branches plus 707 pull-request copies (6,752 versions in all; 3,578 on branches after the 18/10/2026 clean-up). Checklist: reports/personal-data-checklist.md. Values are never shown.

| Area | Score | Why |
|---|---|---|
| Personal Data in Code | ~30 (estimate) | 1 Money: 0/10 (real holdings and cash lines at two banks in server/seed.ts, plus server/seed/householdFinanceSeeds.ts and server/lgtReconciliation.ts); 2 Health: 0/10 (lab results in shared/labSeedData.ts, dental and eye records in server/seed/eyeAndDentalSeeds.ts, screening plans in server/seed/healthPlanningSeeds.ts); 3 Contacts: 5/10 (owner's alert email is fine; email addresses of real doctors, clinics and suppliers in server/seed.ts and the server/seed/ files); 4 ID data: 10/10 (no tax code, date of birth or IBAN in today's code; embedded documents cleaned 18/10/2026); 5 Seed only in database: 0/10 (the files above load real data at start); 6 Fake test data: 5/10 (most tests use made-up values; some use the owner's real email); 7 Notes: 5/10 (CLAUDE.md cleaned on integration 20/10/2026, not yet on master); 8 History: 0/10 (all of the above in old versions; IBANs with valid check digits in old versions of server/swedbankReconciliation.ts); 9 Pull-request copies: 0/10 (tax code, money and health data in old CLAUDE.md and server/seed.ts kept by GitHub in pull-request copies, removed from branches 18/10/2026); 10 Automatic check: 5/10 (server/lib/embeddedAssetsPrivacy.test.ts guards embedded documents only) |

Findings (most serious first):
- High: real money data (holdings, cash, transfers) in today's seed files.
- High: real health data (lab, dental, eye, screening) in today's seed files.
- High: tax code and other ID data still readable in GitHub's pull-request copies.
- Medium: bank account numbers (IBAN) in old history.
- Low: contact emails of real doctors and suppliers in seed files.

What raises the score (owned by the lm-op-model work, not done here): move the real starting data into the database only and replace it in code with made-up values (rules 1, 2, 5: -> ~60); merge the CLAUDE.md clean-up to master; rewrite history (Livio's yes needed) and ask GitHub Support to delete the pull-request copies (rules 8, 9: -> ~90). Or publish a separate clean copy with no history and keep this repo private.
