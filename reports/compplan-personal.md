# compplan: Personal Data in Code (20/10/2026)

Repo 1903978-prog/compplan (private), branch master, all branches plus 75 pull-request copies (1,601 versions). Checklist: reports/personal-data-checklist.md. Values are never shown.

| Area | Score | Why |
|---|---|---|
| Personal Data in Code | ~70 (estimate) | 1 Money: 10/10 (no personal money data; server/seedProposals.ts holds business data: real client names and proposal dates, confidential but not personal); 2 Health: 10/10; 3 Contacts: 5/10 (server/readAISeed.ts holds 10 real meetings with about 20 participants' names, emails and meeting summaries; colleagues' work emails in server/emailTemplates.ts); 4 ID data: 10/10; 5 Seed only in database: 5/10 (employee seed uses made-up people since 18/10/2026; the meeting file above is still in code); 6 Fake test data: 10/10; 7 Notes: 10/10; 8 History: 0/10 (5 real employees with salaries and hire dates in old versions of server/seed.ts, 22/03/2026 to 18/10/2026); 9 Pull-request copies: 10/10 (nothing beyond what branch history has); 10 Automatic check: 0/10 |

Findings (most serious first):
- High: real employees' pay data in old history (server/seed.ts before 18/10/2026).
- Medium: real meeting participants, emails and summaries in server/readAISeed.ts (plan to empty it is on branch claude/privacy-95-step2).
- Low: colleagues' work emails in email templates; client names in proposal seed (business data).

What raises the score: empty server/readAISeed.ts (planned, -> ~80); add an automatic personal-data check (-> ~90); history rewrite only with Livio's yes.
