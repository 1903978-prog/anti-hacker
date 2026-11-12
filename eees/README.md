# EEES — Eendigo Engineering Excellence Standard

The one quality standard for every Eendigo application. It lives only here, in the Secval repository (`1903978-prog/anti-hacker`, folder `eees/`). Apps reference it; they never copy the definitions.

| File | What it is |
|---|---|
| `v1.0/STANDARD.md` | The standard: Livio's specification word for word, plus exactly how scores are computed |
| `v1.0/criteria.json` | Machine-readable registry: 30 dimensions, 102 checks with acceptance tests, weights, ceilings, gates |
| `v1.0/schema/*.schema.json` | JSON Schema of every file below (for apps not written in TypeScript) |
| `apps.json` | Application inventory: owner, tier, repo, hosts, application or subsystem |
| `flows.json` | Cross-application data flows with the 15 required fields and last measured status |
| `evidence/<app>.json` | Each app's evidence register: check results with links, gates, defects, history |
| `integration/<app>.md` | Short adoption steps for each app owner |

Scoring engine: `server/eees/engine.ts`. Dashboard: Secval → **EEES quality** tab (`GET /api/eees`).

## Who does what

- **Secval thread (auditor)** owns the standard, the engine, the dashboard, the ESII index, the flow inventory and the evidence files. It verifies evidence; it never edits another app's code.
- **Each app's own thread** collects and fixes its own evidence: it runs the collector, measures its production checks read-only, and fixes defects in its own repo through its usual draft PRs and approval gates.
- **Livio** approves N/A requests and every production release (exact SHA). Nothing in EEES changes production.

## How an app adopts EEES (once)

1. **Automatic repository checks.** Add this file to the app's repo as `.github/workflows/eees.yml`. It runs only on pull requests into the shipping branch and by hand, never on push:

   ```yaml
   name: EEES
   on:
     pull_request:
       branches: [main]          # the app's shipping branch
       paths-ignore: ["**.md", "docs/**"]
     workflow_dispatch:
   concurrency:
     group: eees-${{ github.ref }}
     cancel-in-progress: true
   jobs:
     eees:
       uses: 1903978-prog/anti-hacker/.github/workflows/eees-collect.yml@integration
       with:
         app: <app id from eees/apps.json>
   ```

   The run's summary shows each check; the artifact `eees-evidence-<app>` holds the JSON. Without the workflow, the same result comes from `node scripts/eees/collect.mjs --app <id> --repo <path-to-app> --run --audit`.
2. **Production checks.** For each check in `v1.0/criteria.json` whose method is `read-only-query`, `telemetry`, `drill` or `browser`, the owner runs the acceptance test read-only and reports the result (status, level, link to the query/output file, date, environment).
3. **Hand the results to Secval.** Put the collector JSON and the production results in `/mnt/project-files/eees/inbox/<app>/` (or link the CI run). The Secval thread checks the evidence and merges it into `evidence/<app>.json`. An owner's statement without a reproducible link is recorded as `agent-claim` and counts as UNKNOWN.

## Reassessment

- Every load of the dashboard recomputes all scores and adds Secval's live monitors (uptime, passive scan, CI result, Secval's own backup drill).
- Every check has a cadence (daily, weekly, monthly, per release). Evidence older than that turns back into UNKNOWN by itself.
- `npm run eees:record` stores today's scores in each evidence file's history (trend). Run it after each assessment round.
- Monthly: the Secval thread reviews the UNKNOWNs with each owner and proposes any change to the standard as a new version (v1.1, ...), never by editing v1.0 in place.
