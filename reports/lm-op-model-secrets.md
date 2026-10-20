# lm-op-model: Secrets in Code (20/10/2026)

Repo 1903978-prog/lm-op-model (private), all branches, 3,578 versions (history cleaned 18/10/2026), scanned with gitleaks 8.21.2 plus a check for database links and key files. Checklist: reports/secrets-checklist.md.

| Area | Score | Why |
|---|---|---|
| Secrets in Code (passwords & keys) | ~90 (estimate) | 1 No secrets in code: 10/10 (15 hits, none real: database setting names like `key = '...'` in server/seed.ts, server/migrations/step04-finance.ts, server/seed/householdFinanceSeeds.ts, a form field name in shared/outlookParser.ts, a public bank page saved for tests, and fake test keys in *.test.ts files); 2 History: 10/10 (28 hits, same kinds); 3 Ignored files: 10/10 (.env in .gitignore); 4 No key files ever added: 10/10; 5 From host settings: 10/10 (APP_PASSWORD, vault and backup keys from Fly settings); 6 No secrets in notes: 10/10; 7 Fake test values: 10/10 (local test scripts use the default local database password only); 8 Automatic scan: 0/10; 9 Leaked keys replaced: 10/10 (none leaked); 10 Workflows use GitHub secrets: 10/10 (relay-backup-secrets.yml reads GitHub secrets) |

Findings: none real. Personal data (not passwords) is a separate privacy topic, see the Privacy column.
Next step to reach 100: add a gitleaks step to the CI.
