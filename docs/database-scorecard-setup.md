# Database scorecard: setup with least privilege (revision 2, 05 Nov 2026)

Nothing here has been merged, deployed or created in Neon/Render. You never paste a password or connection string into Claude or ChatGPT: the password goes only into the Neon SQL Editor and into Render/your own terminal.

## What changed in revision 2

- The login can read **no table data** by default. Step 1 gives it only: connect, see schema metadata (names of tables, columns, indexes, constraints).
- Step 2 is a **generated list of column-level grants** (`GRANT SELECT (key_columns) ON table ...`): only the key columns the orphan checks compare (for example `projects.client_id` and `clients.id`). No table-wide SELECT, no `ALL TABLES`, no default privileges for future tables, no other schema. New tables stay unreadable until the list is regenerated and run again.
- Columns whose names look personal or secret (email, password, token, salary, iban, phone, address, ...) are never granted automatically; they are listed for your decision.
- Secval verifies this before every scan (see "Effective permissions") and refuses to scan if the login can write, change schema, read a whole table, read a secret-looking column, use another schema, or has admin rights.

## Order of operations (approvals are separate)

| Step | What happens | Touches production? | Approval |
|---|---|---|---|
| A | Create the read-only login in Neon (Part 1) | Adds one role per Neon database; no data change | Approved by Livio on 05 Nov 2026 |
| B | **Pre-merge test** with the standalone script or an isolated staging copy (Part 2). Needs no Render change and no deployment of PR #45 to production | No | Included in A |
| C | Merge PR #45 into `integration` (Render auto-deploys new code; the tab stays N/V because no secrets are set yet) | Yes: code deploy | **Separate "merge it"** |
| D | Add the 3 Render secrets (Part 4) | Yes: Render may restart secval | **Separate approval** |
| E | Click **Test connections**, then Deep Audit; apply the generated grants (Part 3) | Read-only | none |

Because B works before C, approving the merge never depends on a feature that only exists after the merge.

## Part 1: create the login (once per Neon project)

Projects: ATLAS `autumn-sun-22098033`, LM OpModel `long-frog-83686748`, Nexus `still-truth-31614363` (links: `https://console.neon.tech/app/projects/<id>`; not opened from the build sandbox, which cannot reach Neon).

1. Open the project, click **SQL Editor**. Pick the **production branch** and your database (usually `neondb`).
2. Run `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public';` and note the owner (usually `neondb_owner`). Expected: one row.
3. In your password manager create a 32-character letters-and-digits password.
4. Paste `docs/sql/dbarch-monitor-role.sql` (https://github.com/1903978-prog/anti-hacker/blob/feature/db-architecture-scorecard/docs/sql/dbarch-monitor-role.sql), replace `<PASSWORD>` and `<DB_NAME>`, click **Run**. Expected: no error.
5. Connection string (keep in your password manager): `postgresql://secval_monitor:PASSWORD@HOST/DB_NAME?sslmode=require`. HOST: project page, **Connect**, switch **Connection pooling** off, copy the host (`ep-....neon.tech`). `?sslmode=require` is mandatory; secval refuses a remote connection without it.

## Part 2: pre-merge test (no production change)

Both options run the same code that will run in production against the same three databases, using a throwaway in-memory store. They connect read-only and verify permissions first.

**Option 1: standalone script, no deployment.** On a computer that can reach Neon (your PC): get Node 20+, then in a terminal:
```
git clone --branch feature/db-architecture-scorecard https://github.com/1903978-prog/anti-hacker
cd anti-hacker && npm ci
set SECVAL_DBARCH_URL_ATLAS=...   (use `export` on Mac/Linux; type the string yourself)
set SECVAL_DBARCH_URL_LM_OP_MODEL=...
set SECVAL_DBARCH_URL_NEXUS=...
npx tsx scripts/dbarch-preflight.ts grants-out
```
It prints pass/FAIL per step, permissions, scores and coverage (no secrets, no SQL, no data) and writes `grants-out/dbarch-grants-<app>.sql`. A Claude session on your PC can run it for you if you set the variables yourself in that terminal first. This path was tested here against a scratch Postgres only; it has **not** been run against Neon.

**Option 2: isolated staging copy on Render** (a second, throwaway Render service built from the PR branch, with its own 3 secrets and its own token; delete it afterwards). It never touches the production secval service. Needs your separate approval because it creates a Render resource holding the secrets.

## Part 3: apply the least-privilege grants

1. After Part 2 (or after step E), open the generated `dbarch-grants-<app>.sql` (or Database tab, app name, **Show required column grants (SQL)**).
2. Read it. Every line is `GRANT SELECT (a few key columns) ON one table TO secval_monitor;`. Lines starting `-- NOT granted` need your decision.
3. Run it in the Neon SQL Editor as the table-owner role. Re-run the test: orphan checks that said "No SELECT grant yet" become real results.

## Part 4: Render secrets and restarts (governance)

Set `SECVAL_DBARCH_URL_ATLAS`, `SECVAL_DBARCH_URL_LM_OP_MODEL`, `SECVAL_DBARCH_URL_NEXUS` under the secval service, **Environment**, **Add Environment Variable** (https://dashboard.render.com).

| Operation | Restarts production? |
|---|---|
| Add / change / delete an environment variable on the secval service | Yes, Render applies it by restarting (or redeploying) the service; the dialog offers the exact buttons. If a "Save only" style option is shown, it stores the value without restarting and it takes effect at the next deploy. Not verified from this sandbox: read the dialog. |
| Merging PR #45 into `integration` | Yes, auto-deploy of new code |
| Creating a Render staging service (Option 2) | No effect on production |
| Rotating the monitor password later | One more restart (change the secret) |
| Rollback by deleting the 3 variables | One more restart; the tab returns to N/V |

Safe sequence: Part 1, Part 2, then (with separate approvals) merge, then secrets, then Test connections. If the dialog offers "Save only", add the 3 secrets before the merge so a single restart covers both.

## Effective permissions secval checks (before every scan)

Not superuser/createdb/createrole/bypassrls/replication; no CREATE on database or schema; no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any table; owns nothing; no privileged role membership; **no table-wide SELECT**; **cannot read secret-looking columns**; **no usable schema besides public**; TLS. Any failure refuses the scan and raises a P0 alert. A table granted to PUBLIC counts as table-wide SELECT; remove that grant if you intend it to be private.
