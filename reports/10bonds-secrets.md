# 10bonds: Secrets in Code (20/10/2026)

Repo 1903978-prog/10bonds (public), all branches, 226 versions, scanned with gitleaks 8.21.2 plus a check for database links and key files. Checklist: reports/secrets-checklist.md.

| Area | Score | Why |
|---|---|---|
| Secrets in Code (passwords & keys) | ~90 (estimate) | 1 No secrets in code: 10/10 (4 hits, all fake test values in lib/seo/share.test.ts:7); 2 History: 10/10 (8 hits, same test file); 3 Ignored files: 10/10 (.env in .gitignore); 4 No key files ever added: 10/10; 5 From host settings: 10/10 (database links come from Fly settings; links in lib/pgUrl.test.ts and lib/accountsUrlScript.test.ts point at fake hosts like ep-x); 6 No secrets in notes: 10/10; 7 Fake test values: 10/10; 8 Automatic scan: 0/10 (no secret scan on each change); 9 Leaked keys replaced: 10/10 (none leaked); 10 Workflows use GitHub secrets: 10/10 (backup.yml uses a throwaway local test database only) |

Findings: none real. Safe as a public repo.
Next step to reach 100: add a gitleaks step to the CI.
