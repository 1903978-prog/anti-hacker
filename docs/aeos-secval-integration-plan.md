# Secval integration plan: central AEOS compliance view (proposal, NOT implemented)

Goal: one read-only page in Secval showing, per application: AEOS version, install status, last validated date, task counts (from `.engineering/BACKLOG.md`), verified vs unverified, open P0/P1, test result, release readiness, pending approvals, stale data.

1. Data source: each repo's `.engineering/` files, read through the GitHub read access the Usage tab already uses (no new secrets). Refresh = nightly job plus manual button. No "real-time" claim.
2. Phase 1 (read-only): server module parses `aeos.config.json`, `aeos.lock.json`, `BACKLOG.md` tables; one new tab. Marks any repo without those files NOT ENROLLED.
3. Phase 2: compliance score = installed + canonical hash matches + validated within 7 days + no open P0/P1 + no UNVERIFIED mandatory gate. A critical defect caps the score regardless of the rest.
4. Constraints: Secval governance rules apply (policy engine untouched, no scanning code, `npm run verify` before push, Livio's "ship it" before any push or PR, warn before spending Actions or Render minutes).
5. Not started: needs Livio's go-ahead, and the Secval workstream owner to confirm no conflict.
