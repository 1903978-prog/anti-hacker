# What we asked Livio

Rule 4 of CLAUDE.md: search this table before asking Livio anything. Add a row for every new ask.
Backfilled 29/10/2026 from this repo's git history. Rows marked (inferred) are what the commits show was needed from Livio, not a recorded message; outcomes come from later commits.

| date | what we asked Livio | why | outcome |
|---|---|---|---|
| 2026-10-18 | Prove ownership of each app domain (DNS TXT record or token file) (inferred) | Scans may only touch assets he owns | Done; allowlist in use |
| 2026-10-20 | Sign in to the Usage tab and provide GitHub, Render, Fly, Backblaze, Neon read access (inferred) | Show costs per app | Done; Usage tab live (#9, #11, #13) |
| 2026-10-23 | Sign-in refusal reason shown instead of asking him to retry (inferred) | He was locked out without explanation | Done (#14) |
| 2026-10-26 | Connect Dropbox variables on Render (inferred) | Backup check needs them | Done; missing names now shown, never values |
| 2026-10-26 | Rule: run `npm run verify` before every push | CI broke twice on the runner | Done (#17) |
| 2026-10-27 | Approve Render free-plan keep-awake ping (inferred) | App slept during the day | Done (#21) |
| 2026-10-28 | GitHub Actions clean-up rules (no CI on session branches, under 50 cents/day) | Actions emails and cost | Done; in CLAUDE.md (#27, #28) |
| 2026-10-28 | Decide on daily health e-mail | He wanted one daily summary | Turned off, not asked for; preview kept (#30, #31) |
| 2026-10-28 | Private-repo GitHub token for the build signal (inferred) | Score caps need CI status of private repos | Added with #30 |
