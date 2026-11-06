# SecVal data quality engine

Every Refresh / Pull / Sync / Import / Reload in an app ends with one call to SecVal. SecVal scores the data with fixed rules (no AI judgment), keeps an append-only audit row, and answers with a score and the problems found. Same input, same policy, same score.

Code: `server/quality/`. Tests: `test/quality.test.ts`. Dates in the UI of the apps use the form `05 Nov 2026`.

## The call

`POST /api/quality/validate` (bearer token, like every API). Body: see `submissionSchema` in `server/quality/routes.ts`.

| Field | Meaning |
|---|---|
| jobId | unique per refresh; a repeat gets 409 |
| app, module, page, dataset, datasetCode, table | which data (table = real PostgreSQL identity) |
| sourceSystem, initiator, kind, startedAt, finishedAt | where from, who, what kind of refresh, when |
| kind | `external_fetch`, `sync`, `import` (need the source), `recompute`, `cache`, `reload` (no new source data) |
| operationCompleted | the app's own job finished |
| sourceReached | true / false / null (no source involved) |
| sourceUnchangedConfirmed | source itself confirmed nothing is new |
| records | the rows after the refresh (max 50,000, 12 MB) |
| references | parent key sets, to check links |
| authoritative | trusted values by record key, to check accuracy |
| access | `initiatorAuthorized`, `violations` |
| expectedChange | losses/additions the source explains |

Answer: `outcome` (PASS / FAIL / UNVERIFIED), `status`, `score` (null when UNVERIFIED), `coverage`, ten dimensions with issues, and a before/after reconciliation (added, updated, removed, unchanged, unexplained). Issues carry counts and up to 5 record keys, never values.

Reading it back: `GET /api/quality/summary` (latest per dataset), `/api/quality/runs`, `/api/quality/runs/:id`, `/api/quality/policy` (weights, bands, every dataset spec).

## Score

`score = sum(dimension score x weight) / sum(weights of applicable dimensions)`. Each dimension is 0 to 100: `100 - sum(100 x failing share x severity factor)`, floored at 0. Severity factors: critical 3, major 1, minor 0.4.

| Dimension | Weight | Rule |
|---|---:|---|
| Accuracy | 20 | fields in `accuracy.fields` equal the authoritative values (relative tolerance in the spec) |
| Completeness | 15 | required fields present; fewer records than `minRecords` is critical |
| Referential integrity | 15 | every foreign key exists in the parent key set; a break is critical |
| Freshness | 10 | newest `freshness.field` within `maxAgeHours` of the refresh end; linear decay to 0 at 3x. A cache or reload only counts with source verification |
| Consistency | 10 | spec rules: `lte`, `equals`, `sum` |
| Uniqueness | 10 | no duplicate business key; a duplicate is critical |
| Validity | 10 | type, min, max, pattern, allowed values |
| Provenance | 5 | `provenance.fields` (source, fetched-at) present on each record |
| Change integrity | 3 | against the last PASS snapshot: unexplained removals, mass overwrite, count jump. Penalty is 0 at the limit and full at twice the limit |
| Access integrity | 2 | permission check reported by the app; a violation is critical |

## What never gets a number

- No spec for the dataset: UNVERIFIED.
- Source not reached (`external_fetch`, `sync`, `import`): UNVERIFIED.
- A dimension that could not be tested (no authoritative values, no parent keys, no baseline yet) is UNVERIFIED and counts 0 in the score. It is never dropped from the denominator.
- If verified weight is below `minCoverage` (80%), the whole run is UNVERIFIED and has no score.
- Only dimensions listed in the spec's `notApplicable`, each with a written reason, are removed and the rest renormalized.
- Any critical issue (operation failed, security violation, broken link, duplicate identity, too few records) forces outcome FAIL, status Critical and a score of at most 49, whatever the aggregate.

## Status bands (central, in `policy.ts`)

95 to 100 Excellent, 85 to 94 Good, 70 to 84 Needs Attention, 50 to 69 Poor, 0 to 49 Critical.
Override with the environment variable `SECVAL_DQ_POLICY` (JSON: `weights` must sum to 100, `bands`, `minCoverage`, `criticalCap`, `severityFactor`, `maxRecords`). A bad override is ignored and shown on `/api/quality/policy`; the policy version of every run is saved.

## Storage

Migration 4: `quality_runs` (one append-only row per refresh, update and delete blocked by triggers) and `quality_snapshots` (the last PASS snapshot per dataset: record key and a 16-character fingerprint, never values). A failed or unverified refresh never replaces the baseline. Each run also writes one line to the audit trail.

## Adding a dataset

Create `server/quality/datasets/<app>.ts` exporting `DatasetSpec[]`, and register it with `registerSpecs`. The spec is the documentation: key, required fields, ranges, links, freshness limit, consistency rules, change limits, and `notApplicable` with reasons.

## On the Health dashboard

The Database column is **measured (M)** for an app once that app has sent at least one scored check: the average of the newest score of each of its tables. The app name in the call (`app`) must match the first part of the address (`compplan` for `compplan.onrender.com`). Until then the column shows the pasted estimate (E), and a check that could not be verified never gives a number.

## Per-app tokens

Apps do not get the main `SECVAL_API_TOKEN`. Set `SECVAL_QUALITY_TOKENS="compplan=<token>,lm-op-model=<token>,nexus-eendigo=<token>,10bonds=<token>"` on secval (each token at least 24 characters) and the matching token as `SECVAL_QUALITY_TOKEN` on each app. A per-app token opens only `POST /api/quality/validate`, only when `app` is its own app and the dataset id starts with `<app>.`. Every other route, reads included, refuses it (401); another app's data gets 403.

Dataset specs: `compplan.ts`, `lm-op-model.ts`, `nexus.ts`, `tenbonds.ts` in `server/quality/datasets/` (written with each app's thread).
