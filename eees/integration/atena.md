# EEES v1.0 — integration steps for ATENA core application

Owner: ATENA (compplan) thread and ATENA audit thread. Repository: 1903978-prog/compplan. Tier: critical. Standard: `eees/v1.0/STANDARD.md` in 1903978-prog/anti-hacker (do not copy it).

**Baseline (12 Nov 2026):** assured 0.2/10, audit coverage 11.8%, release status BLOCKED. Low because most checks have no evidence yet: UNKNOWN counts as 0. This is not a judgement that the app is bad; it says what is proven.

## Steps (owner's thread, no production change)
1. Add `.github/workflows/eees.yml` from `eees/README.md` (app id `atena`) in a draft PR. It runs on pull requests only, never on push.
2. Run the read-only production checks below and save each result (query text + output + date) in `/mnt/project-files/eees/inbox/atena/`.
3. Fix failed checks through your normal draft PRs. Every production release still needs Livio's exact-SHA approval.
4. Tell the coordinator when results are in the inbox; the Secval thread verifies and records them. A statement without a reproducible file counts as UNKNOWN.

## First items to work on (from the improvement engine)
- **D16.1 Figures reconcile to the source of record** (real defect). Failed: Board revenue YTD and Client Ledger receivables differ materially from the source invoices (ATN-003, ATN-004; amounts only in the private register). Proof: Reconciliation of key figures (revenue, receivables, prices, positions) to source on production: unexplained difference = 0.
- **D16.2 Currencies never mixed** (real defect). Failed: Board won column adds two currencies into one total (ATN-005). Proof: Every sum is per currency or converted with a dated rate; query/tests show no mixed-currency totals.
- **D16.4 Domain invariants hold in production** (real defect). Failed: A won case is priced below its cost floor without a logged owner override (ATN-001). Proof: Read-only invariant queries (e.g. price >= cost floor unless approved) return 0 violations.
- **D12.2 Exact-SHA approval before every production deploy** (real defect). Failed: Release gate NOT APPROVED on 14 master merges; the live version has no approval record (ATN-008). Proof: Every production deploy in the period maps to a recorded approval of that exact SHA; unapproved deploys = 0.
- **D06.3 Records linked by stable ids** (real defect). Failed: Proposals link to pricing cases by name, not by id (ATN-002, ATN-010). Proof: Cross-app references use ids/external keys; name-based matching = 0 in code review.
- **D05.4 Flow documentation complete** (real defect). Failed: F1: 6 of 17 fields missing (schema, transformation, idempotency, reconciliation, recovery, e2eEvidence); F2: 11 of 17 fields missing (identityMapping, protocolVersion, schema, transformation, freshnessSloHours, idempotency, errorHandling, reconciliation, monitoring, recovery, e2eEvidence); F3: 12 of 17 fields missing (identityMapping, auth, protocolVersion, schema, transformation, freshnessSloHours, idempotency, errorHandling, reconciliation, monitoring, recovery, e2eEvidence); F4: 7 of 17 fields missing (protocolVersion, schema, transformation, idempotency, reconciliation, monitoring, recovery); F5: 9 of 17 fields missing (identityMapping, protocolVersion, schema, transformation, freshnessSloHours, reconciliation, monitoring, recovery, e2eEvidence); F7: 5 of 17 fields missing (protocolVersion, transformation, reconciliation, recovery, e2eEvidence); F8: 6 of 17 fields missing (identityMapping, protocolVersion, schema, idempotency, recovery, e2eEvidence); F13: 11 of 17 fields missing (sourceOfTruth, identityMapping, auth, protocolVersion, schema, transformation, freshnessSloHours, errorHandling, reconciliation, recovery, e2eEvidence). Proof: Every flow the app produces or consumes has every required EEES flow field filled (eees/flows.json requiredFields: the 15 items of the standard, with frequency and freshness SLO and producer and consumer listed separately).
- **D04.2 Last successful run inside SLO** (real defect). Failed: failing: F2 HubSpot contacts and companies. Proof: Measured last-success timestamp of every consumed flow is within its SLO on production.
- **D03.3 No test or fixture data in production** (real defect). Failed: A test fixture table is present in production. Proof: Read-only scan for fixture schemas, test emails, seed markers in production = 0 findings.

## Critical findings on record
- ATN-001 (P0 financial, open): Final price can go below the cost floor after a manual adjustment
- ATN-002 (P0 financial, open): Proposal weekly price / total fee differ from the priced case on all 5 final cases
- ATN-003 (P0 financial, open): Revenue dated by invoice creation, not issue date: board revenue halved
- ATN-004 (P0 financial, open): Client Ledger receivables overstated
- ATN-005 (P0 financial, open): Board sums EUR and USD together
- ATN-007 (P0 security, open): Mail-arrival webhook not active in production; webhook signing key design weakness (details in the private register)
- ATN-008 (P0 governance, open): Unapproved commits deployed to production (release gate bypassed)
- ATN-009 (P0 data, open): Saving one record can change or remove a different record (5 cases under test)
- ATN-010 (P0 data, fixed-unreleased): Saving a pricing case trashed another client's proposal
- ATN-011 (P0 data, fixed-unreleased): HR writes accept invalid people, pay and dates
- D12.2 failed on production: Exact-SHA approval before every production deploy (Release gate NOT APPROVED on 14 master merges; the live version has no approval record (ATN-008))
- D16.1 failed on production: Figures reconcile to the source of record (Board revenue YTD and Client Ledger receivables differ materially from the source invoices (ATN-003, ATN-004; amounts only in the private register))
- D16.2 failed on production: Currencies never mixed (Board won column adds two currencies into one total (ATN-005))
- D16.4 failed on production: Domain invariants hold in production (A won case is priced below its cost floor without a logged owner override (ATN-001))

## Notes
- Hermes AI (D17) is scored inside ATENA. The accuracy benchmark in /mnt/project-files/hermes-accuracy-2026-11-11/ is the starting evidence; re-run it monthly.
- Pitch Architect and Negotiation Intelligence: confirm whether they live in the compplan repo. If yes, record their checks in their own evidence files, but log each defect once, on ATENA.
- Hard gate G2 stays failed until the P0 financial defects (ATN-001 to ATN-005) are fixed AND verified on production after an approved release.
