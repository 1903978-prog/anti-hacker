# secval database

One SQLite file (`$DATA_DIR/secval.sqlite`, opened by `server/db.ts`),
streamed to Backblaze B2 by Litestream. It is the only master copy; the B2
copy is a backup.

## How the schema changes

- `initSchema()` in `server/db.ts` is the baseline (version 1).
- Every later change is a numbered entry in `server/migrations.ts`. On start
  each missing one runs once, in a transaction, and is recorded in
  `schema_migrations`. Never edit a shipped migration; add a new one.
- Migrations only add (tables, indexes, rules). Rules are triggers, so rows
  already stored are never rewritten.

## Tables

| Table | Holds | Key | Links |
|---|---|---|---|
| `allowlist` | Domains Livio owns and their ownership proof | `domain` | |
| `audit_log` | Append-only trail of every action (triggers block edit and delete) | `id` | |
| `scans` | One row per scan: target, mode, status, times | `id` | `target` = `allowlist.domain` (text, not enforced) |
| `findings` | Weaknesses a scan found (facts only, no site data) | `id` | `scan_id` → `scans.id` (enforced) |
| `app_state` | Key/value settings such as the kill switch | `key` | |
| `uptime_checks` | Home-page checks for the health dashboard | `id` | `host` (text) |
| `health_reports` | Report text pasted in for an app | `id` | `host` (text) |
| `health_scores` | Scores read out of a report | `id` | `report_id` → `health_reports.id` (enforced) |
| `health_infra` | Infrastructure facts read out of a report | `id` | `report_id` → `health_reports.id` (enforced) |
| `schema_migrations` | Which schema changes this database has had | `version` | |

## Rules the database enforces

- `scans.mode` is `passive` or `active`; `scans.status` is `running`,
  `completed` or `aborted`; `scans.findings_count` is 0 or more.
- `findings.severity` is `high`, `medium`, `low` or `info`.
- `health_scores.score` is 0 to 100; `uptime_checks.ok` is 0 or 1.
- `audit_log` rows can never be changed or deleted.

## Indexes

`uptime_checks (host, ts)`, `findings (scan_id)`,
`scans (target, status, finished_at)`, `scans (started_at)`,
`health_reports / health_scores / health_infra (host, created_at)`,
`health_scores / health_infra (report_id)`.

## Deliberate copies (not duplication bugs)

- `scans.findings_count` caches the number of `findings` rows for the scan
  list; it is written in the same transaction as the findings.
- `health_scores.host` and `health_infra.host` repeat `health_reports.host`
  so the dashboard reads one table.
- A changed report is stored again in full, so older scores stay traceable.

## Known gaps

- `scans.target`, `uptime_checks.host` and `health_reports.host` name the app
  as text with no enforced link to `allowlist`. A link would need the
  allowlist table rebuilt, which touches the ownership code, so it is left
  as is.

## Personal data

secval is used by Livio alone, so it holds very little personal data. All of it:

| What | Where | Why | How long |
|---|---|---|---|
| Alert e-mail address | `ALERT_TO` environment variable (Render); falls back to Livio's work address written in `server/notify/alerts.ts` | where new-finding alerts are sent | until the setting is changed |
| Client IP address | server memory only, as the key of the `/api` rate limiter (`server/middleware.ts`); never written to the database or the audit log | stop abuse of the control plane | the current one-minute window; expired entries are dropped at the next sweep, everything on restart |
| `audit_log.actor` | database | who did each action (append-only trail) | for ever (the trail can never be edited or deleted). Today it holds only role names (`operator`, `scheduler`, `uptime`), not a person's name or address |

Findings hold only the fact that a weakness exists on one of Livio's own sites, never data read from the site.

## Outside services

| Service | What it receives | Why | Data-processing terms |
|---|---|---|---|
| Resend | each alert: the alert address, the sender, finding summaries (level, site, title, detail) | sending new-finding alerts | https://resend.com/legal/dpa |
| Backblaze B2 | a continuous copy of the whole database via Litestream (`litestream.yml`): allowlist, audit log, scans, findings, health data; 3 days of history | backup and restore | https://www.backblaze.com/company/policy/dpa-for-eea-eu-residents |
| Render | runs the server: holds the environment (alert address, keys), sees request IPs, keeps its own request and app logs | hosting | https://render.com/dpa |
