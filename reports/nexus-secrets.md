# nexus: Secrets in Code (20/10/2026)

Repo 1903978-prog/nexus-eendigo (private), all branches, 1,849 versions, scanned with gitleaks 8.21.2 plus a check for database links and key files. Checklist: reports/secrets-checklist.md.

| Area | Score | Why |
|---|---|---|
| Secrets in Code (passwords & keys) | ~75 (estimate) | 1 No secrets in code: 10/10 (32 hits, none real: fake test passwords and keys in backend/tests, plus two setting names in backend/app/plan_import.py and backend/app/project_signoff.py); 2 History: 0/10 (an admin login token for Livio's admin account was written in the notes file AUDIT_2026-05-11.md, added 11/05/2026, removed from the code 12/05/2026 but still in the history); 3 Ignored files: 10/10 (.env, .env.* and the audit notes files in .gitignore); 4 No key files ever added: 10/10; 5 From host settings: 10/10 (Fly settings); 6 No secrets in notes: 5/10 (the token above was in a notes file; now blocked by .gitignore); 7 Fake test values: 10/10; 8 Automatic scan: 10/10 (backend/tests/test_no_secrets_in_repo.py checks the code on each test run); 9 Leaked keys replaced: 0/10 (not verified that the login-signing secret was changed after 12/05/2026); 10 Workflows use GitHub secrets: 10/10 |

Findings:
- Real: admin login token in old history (file AUDIT_2026-05-11.md, line 152). It only works while nexus still signs logins with the same secret and the token has not expired. Not verified either way.

Steps for Livio (not done by Claude): replace nexus' login-signing secret and the admin password in Fly settings, which makes the old token useless. Score then -> ~90. Removing it from history would need a history rewrite (only with Livio's yes).
