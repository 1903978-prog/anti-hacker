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
  "orphanRows": 0,
  "uniqueConstraints": 12,
  "checkConstraints": 5,
  "pendingMigrations": 0,
  "lastBackupAt": "2026-11-06T03:00:00Z",
  "lastRestoreTestAt": "2026-11-01T03:00:00Z",
  "integrityOk": true
}
```

`orphanRows`, `pendingMigrations`, `lastBackupAt`, `lastRestoreTestAt` and `integrityOk` may be `null` when the app cannot tell. A `null` scores 0 on its rule and the dashboard says "not reported". Never guess a value.

## The ten rules (10 points each)

| Rule | Full points when |
|---|---|
| Every table has a primary key | share of tables with one (rounded) |
| Links between tables are enforced | at least one foreign key (or only one table) |
| Linked columns are indexed | share of foreign keys whose columns lead an index |
| No broken links | `orphanRows` is 0 |
| Duplicates blocked | at least one UNIQUE constraint |
| Bad values blocked | at least one CHECK constraint |
| Database matches the code | `pendingMigrations` is 0 |
| Backup | `lastBackupAt` within 26 hours |
| Restore tested | `lastRestoreTestAt` within 35 days |
| Integrity | `integrityOk` is true |

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
