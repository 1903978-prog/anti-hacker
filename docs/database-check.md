# Database check (Health dashboard, Database column)

Once an hour, and on "Check all apps now", secval asks each ownership-proven app for a short report about its own database and scores it with ten fixed rules. The result is **measured (M)** in the Database column. Code: `server/health/dbcheck.ts`. Tests: `test/dbcheck.test.ts`.

The report is counts and yes/no answers only. **Never send row data, table names or column names.** Secval keeps only the score and the rule notes.

## What the app must add

`GET /api/secval/db-health`

- Requires `Authorization: Bearer <SECVAL_DBCHECK_TOKEN>`. Compare in constant time. Wrong or missing token: 401. No token configured on the app: 404 (secval then skips the app quietly).
- Read-only. Apps that may only wake their database a few times a day (compplan, Nexus: 6-hour rule) compute the report in their own database window and serve the cached answer; `checkedAt` says when it was computed. Secval accepts a report up to 3 days old and refuses an older one.
- Answer `200` with JSON, under 16 KB:

```json
{
  "version": 1,
  "engine": "postgresql",
  "checkedAt": "2026-11-06T12:00:00Z",
  "tables": 40,
  "tablesWithoutPrimaryKey": 0,
  "foreignKeys": 30,
  "foreignKeysWithoutIndex": 0,
  "tablesInLinks": 38,
  "requiredLinks": 31,
  "requiredLinksValidated": 31,
  "linkCandidatesOpen": 0,
  "tablesClassified": 40,
  "orphanRows": 0,
  "uniqueConstraints": 12,
  "checkConstraints": 5,
  "pendingMigrations": 0,
  "lastBackupAt": "2026-11-06T03:00:00Z",
  "lastRestoreTestAt": "2026-11-01T03:00:00Z",
  "integrityOk": true
}
```

`requiredLinks`, `requiredLinksValidated`, `linkCandidatesOpen` and `tablesClassified` (08 Nov 2026) come from the app's relationship register (`docs/database-relationships.md`): the relationships that must be foreign keys, how many of them are enforced, valid and checked for orphans, how many candidates are still being investigated, and how many tables have a class A to D. **These drive the foreign-key rule.** Without them the rule scores 0.

`tablesInLinks` (optional, diagnostic only since 08 Nov 2026, not scored) is the number of tables that take part in at least one foreign key, as child or parent. `standaloneTables` (optional, only used with `tablesInLinks`) is the number of tables that are standalone by nature (cache, settings, log, reference list) and have no foreign key. Each one must be listed with its reason in the app's own repository, where the auditor reviews it. Since 08 Nov 2026 neither field changes the score: independent tables never count against a database. `orphanRows`, `pendingMigrations`, `lastBackupAt`, `lastRestoreTestAt` and `integrityOk` may be `null` when the app cannot tell. A `null` scores 0 on its rule and the dashboard says "not reported". Never guess a value.

## Secval itself

Secval scores its own SQLite database directly every hour (no network): catalogue counts, `PRAGMA integrity_check` and `foreign_key_check`, applied migrations, and the daily restore drill for the backup and restore rules (only when backups are on and the last drill passed). Without a passing drill those two rules score 0.

## The ten rules (10 points each)

| Rule | Full points when |
|---|---|
| Every table has a primary key | share of tables with one (rounded) |
| Required links are enforced | `requiredLinksValidated / requiredLinks`, rounded down (one missing link never rounds up to 10). No required link: 10 only if `linkCandidatesOpen` is 0. Not reported: 0. The table-link share (`tablesInLinks`) is shown in the note as a diagnostic and never scored. Changed 08 Nov 2026 (Livio's relationship audit) |
| Linked columns are indexed | share of foreign keys whose columns lead an index |
| No broken links | `orphanRows` is 0 |
| Duplicates blocked | at least one UNIQUE constraint |
| Bad values blocked | at least one CHECK constraint |
| Database matches the code | `pendingMigrations` is 0 |
| Backup | `lastBackupAt` within 26 hours |
| Restore tested | `lastRestoreTestAt` within 35 days |
| Integrity | `integrityOk` is true |

## Integrity assessment (separate from the score)

Next to the score, every check stores a verdict that is never averaged into the number, so a high score cannot hide a defect that blocks "done":

- **Critical:** integrity check failed, orphan rows, no backup within 26 hours, no restore test within 35 days.
- **Concerns:** required foreign keys missing or not reported, relationship candidates still open, tables not classified, tables without a primary key, no CHECK rules, pending migrations, integrity or orphan rows not reported.
- **Sound:** none of the above.

**Score cap (08 Nov 2026):** a database cannot show 9/10 or more (the score stays at 89) while orphan rows exist or are not reported, a required foreign key is missing or not validated, required links are not reported, or relationship candidates are still open. The foreign-key rule's note says why.

The dashboard evidence shows it as "Integrity assessment (separate from the score): CRITICAL / CONCERNS / SOUND" with the findings. An app is ready only with a high score **and** a sound assessment.

A failed answer (timeout, bad JSON, wrong shape) is logged and gives no number. A check older than 3 days no longer counts. When the app also sends data quality checks (`docs/data-quality.md`), the column shows the average of both.

## Reference SQL (PostgreSQL, app schemas only)

Replace `$schemas` with the app's own schemas, for example `ARRAY['public']`.

```sql
-- tables and tables without a primary key
SELECT count(*) AS tables,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM pg_constraint c WHERE c.conrelid = t.oid AND c.contype = 'p')) AS tables_without_pk
FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE t.relkind IN ('r','p') AND n.nspname = ANY($schemas);

-- constraints by kind: f = foreign key, u = unique, c = check
SELECT c.contype, count(*) FROM pg_constraint c
JOIN pg_namespace n ON n.oid = c.connamespace
WHERE n.nspname = ANY($schemas) AND c.contype IN ('f','u','c')
GROUP BY c.contype;

-- tables taking part in at least one foreign key (child or parent): tablesInLinks
SELECT count(DISTINCT rel) FROM (
  SELECT c.conrelid AS rel FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE c.contype = 'f' AND n.nspname = ANY($schemas)
  UNION
  SELECT c.confrelid FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE c.contype = 'f' AND n.nspname = ANY($schemas)
) x;

-- foreign keys whose columns do not lead any index
SELECT count(*) FROM pg_constraint c
JOIN pg_namespace n ON n.oid = c.connamespace
WHERE c.contype = 'f' AND n.nspname = ANY($schemas)
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey);
```

- `orphanRows`: 0 when every link is a real foreign key (the database enforces it). For links kept only in code, count child rows whose parent is missing; otherwise `null`.
- `pendingMigrations`: compare the migration files shipped with the app against the migrations table (drizzle: `drizzle.__drizzle_migrations`; alembic: `alembic_version`). `null` if the app uses `drizzle-kit push` without a migrations table.
- `lastBackupAt` / `lastRestoreTestAt`: from the app's own backup job log, or the provider (Neon keeps point-in-time history; a restore test is a real restore into a scratch branch, checked).
- `integrityOk`: true when the queries above ran and returned without error and the app's own consistency checks pass.

## Setting it up (needs Livio, once)

1. Pick one long random value as the shared token.
2. Add it as `SECVAL_DBCHECK_TOKEN` on secval (Render, Environment) and on each app (Render or Fly secrets).
3. Deploy secval and each app after their changes are merged.
4. Press "Check all apps now" on the Health dashboard; the Database column shows M.
