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
