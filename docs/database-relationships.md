# Database relationship coverage: the common standard

Owner: Secval (independent auditor). Ordered by Livio, 08 Nov 2026. Applies to ATLAS / CompPlan, LM OpModel, Nexus, 10bonds and Secval.

The goal is **not** to link every table. It is to find every relationship that must be a foreign key, prove each one is enforced and valid, and document every table that legitimately needs none.

## 1. Table categories (exactly one per table)

| Class | Meaning | Evidence needed |
|---|---|---|
| **A** FK-linked | In at least one valid, enforced foreign key (as child or parent) and **no** required link of it is missing | catalogue (`pg_constraint`, `convalidated = true`) |
| **B** FK-required, incomplete | At least one required link is missing, `NOT VALID`, or has orphan rows. Wins over A: a table with one good FK and one missing one is B | the missing link in the register |
| **C** Legitimately independent | Needs no FK: settings, key-value state, logs, caches, migration bookkeeping, archives, fixtures, unused tables | one-line reason per table |
| **D** External reference / special design | A real reference that a local FK cannot enforce: polymorphic ids, ids from another system or from code, history that must outlive its subject, sentinel-by-design | technical reason plus a code reference (`file:line`) |
| **E** Unresolved | Not enough evidence yet | what is missing |

"Soft key" is not a class: each one ends as B (fix the data, then add the FK) or D (written reason).

## 2. Relationship register (one row per actual or candidate relationship)

Application · child schema.table · child column(s) · parent schema.table · parent column(s) · business purpose · status (`enforced` / `missing` / `invalid` / `justified exception` / `unresolved`) · evidence (code, schema or production data) · orphan rows · index on the child column · ON DELETE / ON UPDATE · migration and compatibility risk · corrective action · owner · issue / PR.

Each application owner keeps its register in its own repository and tells the auditor the path and commit. Secval's register is in code: `server/health/relationships.ts` (`SECVAL_REQUIRED_LINKS`, `SECVAL_EXCEPTIONS`, `SECVAL_TABLES`) and is measured live.

The consolidated register is `reports/db-relationships.json`. Every number in it carries a basis:

- **measured**: the auditor ran a read-only query on production (catalogue or orphan count) or on Secval's live store;
- **reported**: the app owner's own figure, not yet reviewed;
- **unverified**: not known.

## 3. Metrics

| | Formula | Target |
|---|---|---|
| **A** Table classification coverage | tables in class A-D ÷ all in-scope tables | 100% |
| **B** Required FK enforcement coverage (primary) | valid, enforced and validated required FKs ÷ all confirmed required relationships (valid + not validated + missing + invalid) | 100% |
| **C** Required FK discovery coverage | candidates with a disposition ÷ all identified candidates | 100% |
| **D** Legitimately independent tables | class C tables, as a number and ÷ all tables | descriptive, not a target |
| **E** FK implementation backlog | counts of: valid FKs, missing, not validated or invalid, candidates open, justified non-FK relationships, orphan-data issues | |

Rules:

- Every percentage is shown with its numerator and denominator (`48 / 60 = 80%`), rounded down.
- Independent (C) and special (D) tables never enter the Metric B denominator, so they can never lower it.
- A relationship may leave the Metric B denominator only with a written reason the auditor has reviewed (it becomes D).
- No required FK at all shows `0 / 0 = 100% (not applicable)`, and only after the candidate list is fully resolved.
- Discovery limits are reported separately. Metric C covers only the candidates someone looked for (for example `<x>_id` columns); it does not prove that nothing else exists.

A figure is **verified** only when every input is measured and the independent review passed; **provisional** when measured but not yet reviewed; **UNVERIFIED** when any input is only reported.

## 4. Status per database

- **Complete**: classification 100% and verified, FK coverage 100% and verified, no open candidate, review passed.
- **Incomplete**: any confirmed required FK missing, not validated or invalid, or any orphan rows recorded.
- **Unverified**: anything else (classification incomplete, evidence insufficient, review pending).

Every app reports one line:

`Required FKs: X | Validated: Y | Missing/invalid: Z | Coverage: Y / X = N% | Independent tables: A | Classification: B / C = N%`

A value that is not supported by reproducible evidence is written `UNVERIFIED`. X, Y, Z and A are never estimated.

## 5. Secval database score (changed 08 Nov 2026)

`docs/database-check.md` describes the ten-rule score. The foreign-key rule now scores **required FK enforcement** (`requiredLinksValidated / requiredLinks`) from the app's `/api/secval/db-health` report. The share of tables in a foreign key (`tablesInLinks`) is kept as a diagnostic note only; `standaloneTables` no longer changes anything.

The dashboard keeps four things apart:

1. overall database quality score (target 9/10 or more);
2. required FK enforcement coverage (target 100%);
3. table classification coverage (target 100%);
4. the separate integrity verdict (no critical finding).

The score is capped at 89 (below 9/10) while orphan rows exist or are unreported, a required FK is missing or unvalidated, required links are unreported, or candidates are still open. A 9/10 can therefore never hide those defects.

## 6. Who does what

- **Secval (auditor):** owns this standard, the consolidated register, the metrics and the "DB links" tab. Runs read-only production queries, challenges classifications, never edits another app's code.
- **Each app owner:** audits its schema and code, keeps its register, proposes fixes in isolated branches with tests and draft PRs, and verifies after an approved deploy.
- **Livio:** approves every release that adds a foreign key, validates one, or changes production data (orphan repair). Nothing is added or deleted automatically.

## 7. Read-only production queries the auditor runs

Always inside `SET TRANSACTION READ ONLY` on the Neon `production` branch (database `neondb`).

Catalogue per schema:

```sql
WITH t AS (SELECT c.oid, n.nspname AS sch FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','p') AND NOT c.relispartition
             AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'),
     fk AS (SELECT conrelid, confrelid, convalidated FROM pg_constraint WHERE contype = 'f'),
     linked AS (SELECT conrelid AS oid FROM fk UNION SELECT confrelid FROM fk)
SELECT sch, count(*) AS tables,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = t.oid AND p.contype = 'p')) AS no_pk,
       count(*) FILTER (WHERE oid IN (SELECT oid FROM linked)) AS in_links,
       (SELECT count(*) FROM fk JOIN t c ON c.oid = fk.conrelid WHERE c.sch = t.sch) AS fks,
       (SELECT count(*) FROM fk JOIN t c ON c.oid = fk.conrelid WHERE c.sch = t.sch AND NOT fk.convalidated) AS fks_not_valid
FROM t GROUP BY sch ORDER BY sch;
```

Orphan count for one candidate (text comparison, so type differences do not hide orphans):

```sql
SELECT count(*) FROM child t
WHERE COALESCE(t.col::text, '') <> ''
  AND NOT EXISTS (SELECT 1 FROM parent x WHERE x.key::text = t.col::text);
```

For many candidates at once the auditor wraps that query in `query_to_xml(format(...))` over a `VALUES` list, so one read-only statement returns every count.

## 8. Definition of done (per database)

100% of in-scope tables classified · every candidate has a reviewed disposition · 100% of confirmed required FKs enforced and validated · every exception documented and independently reviewed · no unresolved integrity-critical orphan data · reproduced against the production schema · dashboard values equal the verified register.
