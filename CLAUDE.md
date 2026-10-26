# secval — standing rules for Claude

**What this is:** an authorized continuous security-validation platform — a
self-service scanner that Livio runs against **his own assets only**. The
governance/safety layer is the heart of the product: no capability that
touches a target may exist or run until that layer approves it.

## Hard rules (never break these)

1. **One branch.** All work merges into the `integration` branch. Do not
   create other long-lived branches.
2. **No ship without the word.** Do **not** open a PR, push to a remote, or
   deploy anything unless Livio writes the exact words **"ship it"**. Until
   then, commit locally to `integration` only.
3. **Tests stay fast.** Run only the tests for the module you touched, aiming
   for well under two minutes. CI is the full gate, not local runs.
4. **Warn before spending.** Warn Livio before any action that would consume
   GitHub Actions minutes or Render compute.
5. **Governance first.** Build and test the safety layer before any scanning
   capability. Scanning code must call the policy engine for approval and
   **cannot bypass or disable it**.
6. **Run the full gate before every push.** `npm run verify` runs exactly what
   CI runs (type check, lint, tests, page check). If Chromium is missing, set
   `PW_CHROMIUM` to an installed one (cloud sessions: `/opt/pw-browsers/chromium`).
   Any change to `public/` (colours, columns, links) must pass the page check,
   in light and dark. Do not push on a red or unrun `verify`. Rule 3 applies
   to editing loops only, not to the last run before a push.

## Safety invariants the code must uphold

- **Fail closed.** If the policy engine is unreachable or denies, the action
  does not run.
- **Allowlist only.** A URL not on the ownership allowlist can never be
  scanned. A domain cannot become scan-eligible until ownership is proven
  (DNS TXT record or a token file on the site, verified by the tool).
- **Resource caps.** Every scan is bounded: max requests/second, max total
  requests, max runtime, max retained response data, and zero data-mutating
  operations in the default profile. Exceeding any cap aborts the scan.
- **Immutable audit trail.** Every scan action is logged append-only
  (target, mode, who, when, result). Logs are never edited or deleted.
- **Kill switch.** A single switch stops all running scans immediately.
- **Retain findings, not data.** A scan keeps only the fact that a weakness
  exists, never the underlying data it read from a target.

## Stack

Node/Express 5 + (React client later) · better-sqlite3 for the store · zod for
validation · TypeScript (tsx to run, vitest to test) · hosted on Render.
