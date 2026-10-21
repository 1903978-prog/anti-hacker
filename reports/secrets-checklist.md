# Secrets in Code checklist (passwords & keys)

One 10-rule checklist for every app with a code repository (Livio, 20/10/2026). It answers: if this code were made public on GitHub, could someone get a password, key or token out of it?

Each rule scores 10 (done), 5 (partly) or 0 (missing); the score is the total (0-100).
How it is checked: the free scanner gitleaks (v8.21.2) runs over today's code and over every past version of every branch, then each hit is checked by hand. Reports never contain a secret's value: only the file, the line, the kind of secret and whether it is real or a fake test value.

1. No real password, key or token in today's code.
2. No real password, key or token anywhere in the code's history (a secret deleted later is still readable in old versions).
3. Settings files (.env) and key files are in .gitignore, so they can't be added by mistake.
4. No settings or key file (.env, .pem, .key, credentials) was ever added to the code.
5. The app reads its passwords and keys from the host's settings (Render, Fly, GitHub secrets), not from the code.
6. No secrets in notes, reports or docs kept with the code.
7. Tests use obvious fake values, never real ones.
8. Every change is scanned for secrets automatically (a CI step or a test).
9. Any key that ever leaked has been replaced (10 if none leaked).
10. Automatic jobs (GitHub workflows) take secrets from GitHub's secret store only.

Apps without a code repository (eendigo.com, WordPress) are not rated ("-").

Not checked: secrets inside the hosted servers, databases or uploaded files; only the code repository.
