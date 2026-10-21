# nexus: Personal Data in Code (20/10/2026)

Repo 1903978-prog/nexus-eendigo (private), all branches plus 165 pull-request copies (1,891 versions). Checklist: reports/personal-data-checklist.md. Values are never shown.

| Area | Score | Why |
|---|---|---|
| Personal Data in Code | ~70 (estimate) | 1 Money: 10/10; 2 Health: 10/10 (the "diagnostic" words are the product's own feature, not health data); 3 Contacts: 5/10 (about 44 real colleague work emails at the company domain across code, workflows and tests); 4 ID data: 10/10; 5 Seed only in database: 10/10; 6 Fake test data: 5/10 (most tests use made-up addresses, some use real colleague emails, e.g. backend/tests/test_audit_trail_admin.py, test_project_workflow.py); 7 Notes: 5/10 (CLAUDE.md lists colleague emails); 8 History: 5/10 (about 63 colleague work emails over time; no ID, money or health data found); 9 Pull-request copies: 10/10 (nothing beyond branch history); 10 Automatic check: 0/10 |

Findings: Low to medium: colleague work emails (names) in code, tests and notes. No money, health or ID data found.

What raises the score: replace colleague emails in tests and CLAUDE.md with made-up ones (-> ~85); add an automatic check (-> ~95).
