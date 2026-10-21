# Personal Data in Code checklist

One 10-rule checklist for every app with a code repository (Livio, 20/10/2026). It answers: if this code were made public on GitHub, would real people's private data become visible? It is separate from "Secrets in Code" (passwords and keys, reports/secrets-checklist.md) and from "Privacy" (how the running app treats data).

Each rule scores 10 (done), 5 (partly) or 0 (missing); the score is the total (0-100).
How it is checked: a scan of today's code, of every past version on every branch, and of the copies GitHub keeps for each pull request (refs/pull/*), looking for money data (bank names next to large amounts, IBANs), health data (lab, dental, screening records), contact data (emails, phone numbers, street addresses), ID data (tax codes, dates of birth, passports) and real people in seed data; then each hit is checked by hand. Reports never contain a value: only the file, the kind of data and how serious it is.

1. No real money data (balances, holdings, account numbers) in today's code.
2. No real health data in today's code.
3. No real names, emails, phone numbers or addresses of people in today's code (the owner's own alert address is fine).
4. No ID data (tax code, date of birth, passport, IBAN) in today's code.
5. Real starting data lives only in the database, not in seed files.
6. Tests and examples use made-up people and numbers.
7. Notes files (CLAUDE.md, docs, reports) hold no personal details.
8. No personal data anywhere in the code's history (deleted data is still readable in old versions).
9. No personal data in GitHub's pull-request copies (they survive a history rewrite; only GitHub Support can delete them).
10. Every change is checked for personal data automatically (a CI step or a test).

Apps without a code repository (eendigo.com, WordPress) are not rated ("-").

Not checked: personal data inside the live databases, uploaded files or backups; only the code repository.
