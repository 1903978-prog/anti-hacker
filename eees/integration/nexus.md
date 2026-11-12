# EEES v1.0 — integration steps for Nexus / Project Guard

Owner: Nexus thread. Repository: 1903978-prog/nexus-eendigo. Tier: critical. Standard: `eees/v1.0/STANDARD.md` in 1903978-prog/anti-hacker (do not copy it).

**Baseline (12 Nov 2026):** assured 0.4/10, audit coverage 5%, release status NOT READY. Low because most checks have no evidence yet: UNKNOWN counts as 0. This is not a judgement that the app is bad; it says what is proven.

## Steps (owner's thread, no production change)
1. Add `.github/workflows/eees.yml` from `eees/README.md` (app id `nexus`) in a draft PR. It runs on pull requests only, never on push.
2. Run the read-only production checks below and save each result (query text + output + date) in `/mnt/project-files/eees/inbox/nexus/`.
3. Fix failed checks through your normal draft PRs. Every production release still needs Livio's exact-SHA approval.
4. Tell the coordinator when results are in the inbox; the Secval thread verifies and records them. A statement without a reproducible file counts as UNKNOWN.

## First items to work on (from the improvement engine)
- **D05.4 Flow documentation complete** (real defect). Failed: F4: 7 of 17 fields missing (protocolVersion, schema, transformation, idempotency, reconciliation, monitoring, recovery); F5: 9 of 17 fields missing (identityMapping, protocolVersion, schema, transformation, freshnessSloHours, reconciliation, monitoring, recovery, e2eEvidence); F7: 5 of 17 fields missing (protocolVersion, transformation, reconciliation, recovery, e2eEvidence); F13: 11 of 17 fields missing (sourceOfTruth, identityMapping, auth, protocolVersion, schema, transformation, freshnessSloHours, errorHandling, reconciliation, recovery, e2eEvidence). Proof: Every flow the app produces or consumes has every required EEES flow field filled (eees/flows.json requiredFields: the 15 items of the standard, with frequency and freshness SLO and producer and consumer listed separately).
- **D08.3 Database roles are least-privilege** (unverified). No reliable evidence yet. Proof: Production role inspection: app roles have no SUPERUSER, CREATEROLE or BYPASSRLS; read-only roles cannot write.
- **D08.4 No cross-client data exposure** (unverified). No reliable evidence yet. Proof: Data isolation test with two clients shows no leakage across screens, exports and APIs.
- **D09.1 No secrets in the repository** (unverified). No reliable evidence yet. Proof: Secret scan of the full repository and history finds 0 live secrets.
- **D23.3 Restore drill passes** (unverified). No reliable evidence yet. Proof: Restore of the latest backup into an isolated database; row counts and checksums match; RTO measured.
- **D16.1 Figures reconcile to the source of record** (unverified). No reliable evidence yet. Proof: Reconciliation of key figures (revenue, receivables, prices, positions) to source on production: unexplained difference = 0.
- **D16.2 Currencies never mixed** (unverified). No reliable evidence yet. Proof: Every sum is per currency or converted with a dated rate; query/tests show no mixed-currency totals.
- **D16.4 Domain invariants hold in production** (unverified). No reliable evidence yet. Proof: Read-only invariant queries (e.g. price >= cost floor unless approved) return 0 violations.

## Critical findings on record
- none recorded yet (not the same as none existing)

## Notes
- Project Guard is scored as part of Nexus (same repo and deploy).
- Re-read /api/version after each approved release so the dashboard shows the exact live SHA (last Secval read: 2ed2901e, 10 Nov).
- Flow F4 (call recordings to ATENA): record the first production import result (due 12 Nov 02:00 UTC) as flow evidence.
