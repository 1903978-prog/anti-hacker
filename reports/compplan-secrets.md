# compplan: Secrets in Code (20/10/2026)

Repo 1903978-prog/compplan (private), all branches, 1,593 versions, scanned with gitleaks 8.21.2 plus a check for database links and key files. Checklist: reports/secrets-checklist.md.

| Area | Score | Why |
|---|---|---|
| Secrets in Code (passwords & keys) | ~75 (estimate) | 1 No secrets in code: 5/10 (a think-cell software licence key is written in server/seedSteps/opsSchema.ts:118; other hits are not secrets: a page setting name in client/src/pages/OkrTree.tsx and a fake test password in server/privacyErrors.test.ts); 2 History: 5/10 (the same licence key since 28/04/2026, first in server/seed.ts); 3 Ignored files: 10/10 (.env, .env.* and key files in .gitignore); 4 No key files ever added: 10/10 (only .env.backup.example with placeholders); 5 From host settings: 10/10 (DATABASE_URL, APP_PASSWORD, SESSION_SECRET from Render settings); 6 No secrets in notes: 10/10; 7 Fake test values: 10/10 (CI database passwords are for throwaway local test databases); 8 Automatic scan: 0/10; 9 Leaked keys replaced: 5/10 (licence key not replaced); 10 Workflows use GitHub secrets: 10/10 |

Findings:
- Real: think-cell licence key (software licence, not a login to data) in server/seedSteps/opsSchema.ts line 118 and in history. Risk if public: someone could use the licence. It gives no access to compplan's data.

Steps for Livio (not done by Claude): ask think-cell for a new licence key if the repo will ever be public; Claude can then move the key into a Render setting.
