# 10bonds: Personal Data in Code (20/10/2026)

Repo 1903978-prog/10bonds (already public), all branches plus 105 pull-request copies (314 versions). Checklist: reports/personal-data-checklist.md. Values are never shown.

| Area | Score | Why |
|---|---|---|
| Personal Data in Code | ~85 (estimate) | 1 Money: 10/10 (lib/brokers/seed.json is public broker information, not personal); 2 Health: 10/10; 3 Contacts: 10/10 (only the owner's own address, for admin and alerts, in lib/accounts.ts and .github/workflows/email-check.yml); 4 ID data: 10/10; 5 Seed only in database: 10/10; 6 Fake test data: 5/10 (lib/accountsUser.test.ts uses the owner's real email); 7 Notes: 10/10; 8 History: 10/10; 9 Pull-request copies: 10/10; 10 Automatic check: 0/10 |

Findings: Low: the owner's personal email is public in the repo (already public). Consider a separate alert address.
