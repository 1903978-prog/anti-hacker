# Five-app database certification: dashboard and release request
Secval auditor, 08 Nov 2026, 14:00 UTC. Draft. Nothing merged, deployed or changed in production.

## Bottom line
- **No app is certified yet.** None reaches 9/10 or 100% required foreign-key coverage. Every app has missing required links, and three also have orphan rows or unproven restores. Under Secval's rule these cap every score below 9.
- **No official measured score exists today for any of the five apps.** Live Secval still runs the 07 Nov release (schema 5). The secrets and per-app links cannot be checked from outside until the public measurement status in Secval #50 is live.
- Production foreign-key figures below are **measured** (read-only Neon queries, 08 Nov 04:51-05:05 UTC). Owner figures are marked **reported** and are not yet independently sampled.

## Executive dashboard

| App | DB score /10 | Required FKs | Valid FKs (prod) | FK coverage | Independent tables | Classification | Orphans | Backup / restore | Critical gaps | Owner | Next approval |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Secval** | Not measured live. Capped below 9 until the release | 4 (register) | 3 (migration 7 not live) | 3/4 = 75%. 4/4 tested on a copy | 6 of 13 | 13/13 = 100% | 0 on enforced links (live /health, 08 Nov 01:38) | Unverified (not shown publicly until #50 is live) | Missing link quality_snapshots.job_id; backup proof | Secval threads | Secval release (#50 + #51 + migration 7) |
| **ATLAS / compplan** | Not measured. Capped below 9 | 241 (reported) | 3 (measured) | 3/241 = 1.2% | 113 (reported) | 387/411 = 94% (reported) | Measured: 21, 9 (sentinel 0), 3, 2 real, and 15 history refs (allowed only if explained) | Backup OK 07 Nov 13:46 (verified on GitHub); none since. Restore drill passes only on unreleased code | 238 missing FKs, real orphans, restore fix not live, 37 open candidates | compplan thread | Recovery release (#749 or #745), then the FK plan in batches |
| **LM OpModel** | Not measured. Capped below 9 | 74 (reported) | 52 (measured) | 52/74 = 70% | 79 (reported) | 174/193 = 90% (reported) | 0 on existing FKs; 22 missing links not yet checked | Weekly central backup started 08 Nov 12:55 (verified on GitHub); no restore evidence | 22 missing FKs, 19 unclassified tables, 2 tables without a PK (ownership review) | lm-op-model thread | #845 or #826 FK migration |
| **Nexus** | Not measured. Capped below 9 | 163 (reported) | 123 valid + 3 NOT VALID (measured) | 123/163 = 75% | 27 (reported) | 160/160 = 100% (reported) | 0 on the 3 NOT VALID links (measured); 37 missing links not checked | Unverified | 37 missing FKs, 3 to validate, 1 declared link absent in production | Nexus thread | #212 (migration 8) + VALIDATE of 3 FKs |
| **10bonds** | Not measured. Capped below 9 | 45 (reported) | 32 (measured) | 32/45 = 71% | 27 (+16 special design) (reported) | 84/84 = 100% (reported) | **74,236 (measured): critical** (73,560 + 673 + 3) | Unverified | Orphans, 13 missing FKs | 10bonds thread | #497 (13 FKs + production data repair) |

"Not measured" is never counted as zero. A score appears here only after Secval itself measures it after a release.

## What I checked myself today
- Secval live: /health is ok, store schema 5, 0 broken links. Its exact build can't be seen from outside, so #50 adds it.
- compplan live: commit **0d97988**, started 08 Nov 13:31 (UI-only "premium Pipeline Card" release). All compplan recovery drafts (#725, #745, #747, #749) are based on 4db63b7 and need rebasing onto 0d97988.
- Secval #50 + #51 combined: `npm run verify` green (29 files, 300 tests, type check, lint, page check in light and dark).
- Migration 7 on an isolated copy: all snapshots kept, link enforced, orphan insert refused. With an orphan present, it rolls back cleanly and the app refuses to start, so Render keeps the old version.
- Backup runs: compplan (daily DB backup OK 07 Nov; restore drill green on branch heads b011027c and 554aa8d8) and LM OpModel (central backup start OK). Nexus and 10bonds: no evidence source available to me.

## Consolidated release request (for Livio; each line needs its own written go)

| # | Release | Exact head (today) | Migrations / data | Evidence | Main risk | Rollback |
|---|---|---|---|---|---|---|
| 1 | **Secval**: #50 then #51 (one unit) | **#51 head ed71af4** (contains #50 head a9626b7); verify green on it, 300 tests | Migration 6 (adds a column), migration 7 (rebuilds quality_snapshots with a FK) | verify green, 300 tests; migration 7 tested on a copy | If production has an orphan snapshot, the new build won't start (old one stays live). Before release, count snapshots whose job_id is not in quality_runs on the production store; it must be 0 | Render: previous deploy. Migrations only add, so the old code still runs |
| 2 | **compplan recovery** (restore fixes, deploy gate, migration status) | #749 898dde1 (= #725 + #733 + #747), must be rebased on live 0d97988 | No business-data change | Drill runs 42430371637 and 42448143646 green (verified) | Rebase onto the new live commit | Render rollback to 0d97988 |
| 3 | **compplan FK plan** | #697 / #686 (owner to name one head) | Adds FKs in batches. Orphans first: salary_history needs Livio's design choice (Retire vs. park in trash) | Owner register #746 | 238 links: needs batches, not one release | Each batch is reversible (drop constraint) |
| 4 | **LM OpModel FKs** | #826 45bf0cd (owner to confirm against #845) | Adds 22 FKs | Owner tests | Unchecked orphans on the 22 links | Drop constraint |
| 5 | **Nexus** | #212 (owner to confirm head) | Migration 8 (4 NOT VALID FKs) + VALIDATE 3 existing | 0 orphans on the 3 (measured) | Low | Drop constraint |
| 6 | **10bonds** | #497 (owner to confirm head) | 13 FKs + **production data repair** (clears 73,563 dead run ids, re-creates 32 visitor rows) | Owner tests; orphan counts measured | Changes production data | Backup before release; repair is listed row by row in the PR |

**Order:** 1 first (so Secval can measure the rest), then 2, 5, 4, 6, then 3 in batches. After each release Secval re-measures production and updates this page.

## What only Livio can do
1. Approve the releases above, one by one, in writing.
2. Confirm in Render (secval, compplan) and Fly (lm-op-model, nexus-eendigo, 10bonds) that the tokens from `secrets-to-set.md` were saved. After release 1, the public /health shows this as yes/no, so the check needs no one.
3. compplan salary_history: choose Retire or park the history in the trash.
