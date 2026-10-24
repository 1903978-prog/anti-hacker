# secval

An authorized continuous security-validation platform — a self-service
scanner for **my own assets only**. The governance/safety layer is built and
tested before any scanning capability exists.

> Status: **Phases 1–3 complete** — governance spine, passive scanner + UI,
> and a weekly automatic sweep. See `CLAUDE.md` for standing rules and safety
> invariants.

## Phase 1 — what's here

- **Policy engine** (`server/governance/policy.ts`) — the single gate every
  scan must pass. Independent of scanning code, cannot be bypassed, and
  **fails closed**: anything unknown or erroring is denied.
- **Ownership allowlist** (`server/ownership/allowlist.ts`) — a URL not on the
  list can never be scanned. Seeded with my domains, all unproven until
  verified. A domain cannot become active-eligible before ownership is proven.
- **Proof of ownership** (`server/ownership/proof.ts`) — prove a domain via a
  DNS TXT record or a token file on the site; the tool verifies it.
- **Resource limits** (`server/governance/limits.ts`) — hard caps on
  requests/second, total requests, runtime, and retained data; zero
  data-mutating operations by default.
- **Immutable audit trail** (`server/audit/log.ts`) — every action is logged
  append-only; database triggers reject any edit or delete.
- **Kill switch** (`server/governance/killswitch.ts`) — one switch halts all
  scans; while engaged the policy engine denies every request.

## Run

```bash
npm install
npm start          # http://localhost:3000  (health at /health)
npm test           # vitest — the safety-layer tests
npm run typecheck
```

The SQLite store lives under `DATA_DIR` (default `./data`) and holds the
allowlist, scan history, and audit trail.

## HTTP endpoints (Phase 1)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + kill-switch state |
| GET | `/api/allowlist` | list allowlisted domains |
| POST | `/api/allowlist` | add a domain (unproven) |
| DELETE | `/api/allowlist/:domain` | remove a domain |
| POST | `/api/allowlist/:domain/challenge` | issue an ownership challenge token |
| POST | `/api/allowlist/:domain/verify` | verify ownership (`dns-txt` or `token-file`) |
| POST | `/api/allowlist/:domain/active-eligible` | toggle active-eligibility (requires proof) |
| GET | `/api/audit` | read the append-only audit trail |
| POST | `/api/kill-switch/engage` · `/release` | halt / resume all scans |
| POST | `/api/scan/preflight` | ask the policy engine for approval (runs nothing) |
| POST | `/api/scan` | run a passive scan of a proven target |
| GET | `/api/scans` · `/api/scans/:id/findings` | scan history and findings |
| GET | `/api/schedule` | weekly schedule config + last run |
| POST | `/api/schedule/run-now` | run the sweep across proven targets now |

## Automatic scans

A weekly sweep runs every **Monday 08:00 Europe/Paris** (CET/CEST), scanning
every ownership-proven target in passive mode through the same policy gate.

> **Caveat:** the scheduler runs inside the web process. On Render's free tier
> the service sleeps when idle, so a sweep can be missed if nothing wakes it.
> For reliable timing, keep the service always-on or trigger
> `POST /api/schedule/run-now` from an external scheduler (e.g. a Render cron).

## New-finding alerts

After every sweep (weekly or `run-now`), each scan is compared with the
previous completed scan of the same site. Findings of level low, medium or
high that were not there last time are sent in **one** e-mail (highest level
first). Only the finding itself is sent, never data read from the site.

| Setting | Meaning |
| --- | --- |
| `RESEND_API_KEY` | Resend key; without it nothing is sent and the audit trail records `alert.skipped` |
| `ALERT_TO` | recipient (default `livio.moretti@eendigo.com`) |
| `ALERT_FROM` | sender (default `notifications@operations.eendigo.com`) |

A failed send never stops a sweep; it is recorded as `alert.failed`. Known
limit: without Litestream the free-tier store resets, so after a reset every
finding counts as new once.

## Usage tab

`GET /api/usage` (and the **Usage** tab) shows this month's use of the free
allowances: GitHub Actions minutes, storage and billed amount; Render
bandwidth and services; Neon compute hours and data out per project; Fly machines with an estimated monthly cost (Fly has
no billing API); Backblaze free caps with a link (Backblaze has no usage API).
Only GET calls are made; results are kept 15 minutes. A provider without a
token shows "not connected".

| Setting | Meaning |
| --- | --- |
| `GITHUB_USAGE_TOKEN` | fine-grained GitHub token with the account permission **Plan: read** only |
| `GITHUB_USAGE_USER` | GitHub account (default `1903978-prog`) |
| `RENDER_API_KEY` | Render API key (Render has no read-only keys; secval only reads with it) |
| `FLY_API_TOKEN` | read-only Fly org token (`fly tokens create readonly`) |
| `FLY_ORG` | Fly organization (default `personal`) |
| `NEON_API_KEY` | Neon API key (account settings, API keys); secval only reads with it |
| `NEON_ORG_ID` | optional, only if the Neon projects are in an organization |
| `NEON_PROJECT_APPS` | optional `project name=app,...` for Neon projects whose name does not say the app |

## Dropbox copies column

Each app that backs up to Dropbox (compplan, lm-op-model, nexus, 10bonds,
secval) gets a **Dropbox copies** column and a detail block: a rating
(healthy / warning / failing) for the database copy and the code copy, the
date of the last upload, the size, and the reason in plain words. Healthy =
newest copy under 36 hours old; warning = under 72 hours, or a copy under half
its usual size; failing = older, empty or missing. Checked every 6 hours and by
"Check now". Only folder listings are read (file names, sizes, upload times);
contents are never downloaded and only those facts are stored.

| Setting | Meaning |
| --- | --- |
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` | the same three values the apps already use for their Dropbox backups; without them the column says "not connected" |
| `DROPBOX_BACKUP_FOLDERS` | optional JSON `{"nexus": ["/nexus/CODE", "/nexus/DB"]}` to override where to look; default `/<app>/CODE`, `/<app>/DB` and `/App backups/<app>` |

## Next (ideas)

Active (authenticated / deeper) scanning for active-eligible targets and
richer passive checks.
