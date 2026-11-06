# AEOS compliance dashboard in Secval (built as a draft; nothing deployed)

**What exists (this PR):** an "AEOS" tab (`#aeos`) in Secval showing, per application, AEOS version, installation, validation result, the repo's own AEOS test result, tasks verified / not verified, open P0/P1, open blockers, pull request (link, draft, mergeable), fresh-session test results, release readiness, approvals still needed, items not verified, last checkpoint and a score with its parts. Data comes from `reports/aeos-compliance.json`.

**Where the data comes from:** `scripts/aeos/collect.py` runs each enrolled repository's own `aeos.py validate` and AEOS tests and reads its `.engineering/` files; pull request facts are copied in from GitHub through a manifest. It makes no network call and changes nothing in the repositories.

**What it is not:** real-time. Nothing refreshes the file by itself: the page shows the collection date, a banner appears after 7 days (`STALE_AFTER_DAYS`), and a missing or invalid file is reported as such, never as zeros. Refresh by running the collector again and committing the file.

**Score (documented in the data and on the page):** installed 20, validation ok 25, repo's AEOS tests pass 20, fresh-session evidence 15, draft PR open and mergeable (state "clean") 10, no open P0/P1 or blockers 10. It measures AEOS installation and proof, not application quality.

**Secval rules respected:** read-only, no scan or policy-engine code touched, API behind the existing token check, `npm run verify` green including the page check in light and dark at 1440, 390 and 360 px.

**Tests:** `test/aeos.test.ts` (file shape, staleness, github-only links, token, no-data; three of its guards were mutation-checked) and `test/aeos-register.test.ts` (the compliance register matches the data). The collector is covered by `scripts/aeos/test_aeos.py`.

**Not built (proposals):** an automatic nightly refresh (needs a schedule and read access to the other repositories, a cost and access decision for Livio); reading task counts live from GitHub instead of the repo files.
