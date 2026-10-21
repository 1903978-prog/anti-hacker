# secval: Secrets in Code (20/10/2026)

Repo 1903978-prog/anti-hacker (public since 20/10/2026), all branches, 73 versions, scanned with gitleaks 8.21.2 plus a check for database links and key files. Checklist: reports/secrets-checklist.md.

| Area | Score | Why |
|---|---|---|
| Secrets in Code (passwords & keys) | ~90 (estimate) | 1 No secrets in code: 10/10 (0 hits); 2 History: 10/10 (0 hits in 73 versions, 4 pattern hits were package checksums in package-lock.json, not secrets); 3 Ignored files: 10/10 (.env in .gitignore); 4 No key files ever added: 10/10; 5 From host settings: 10/10 (SECVAL_API_TOKEN and Backblaze keys are Render settings); 6 No secrets in notes: 10/10; 7 Fake test values: 10/10; 8 Automatic scan: 0/10 (no secret scan on each change yet); 9 Leaked keys replaced: 10/10 (none leaked); 10 Workflows use GitHub secrets: 10/10 |

Findings: none real. Safe to keep public.
Next step to reach 100: add a gitleaks step to the CI that runs on every push.
