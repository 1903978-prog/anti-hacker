# What we asked Livio

## Rule 2 — Request IDs and release proof (second priority after time protection)
1. Every new request from Livio gets a permanent ID before any work starts: <REPO-PREFIX>-<4-digit running number> (10B, LMO, NEX, CPP, SEC …). Never reuse or renumber an ID.
2. Log each ID in docs/requests.md (one row): ID · date · request in Livio's words (short) · status (open / in progress / done / dropped) · commits · release.
3. Session replies to Livio start with the ID(s) they are working on.
4. docs/core-functions.md lists the app's key existing functions (max ~25), each with a fast check (test, script or URL check). Create it now if missing.
5. Every release (fly deploy / ship) writes a release note in docs/releases.md AND in the reply to Livio with three lists:
   - Completed: IDs finished in this release
   - Tested: IDs and how each was tested (test name or live check on production)
   - Not broken: core functions checked this release, each pass/fail
   A release with any core function failing is not shipped (Fly apps: roll back).
6. Open IDs older than 7 days are listed at the end of every release note.
7. Checks stay fast: targeted tests plus the core-function checks, under 2 minutes total.


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
