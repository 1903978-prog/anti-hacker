# Database scorecard: setup, read-only access (needs Livio's separate approval to start)

Nothing here has been done. Do it only after you approve it in writing. You never paste a password or connection string into Claude or ChatGPT: the password goes only into the Neon SQL Editor and the Render secret.

Total time about 10 minutes per database.

## Part 1: create the read-only login (repeat for each of the 3 Neon projects)

| App | Neon project id | Direct link (not opened from the build sandbox, which cannot reach Neon) |
|---|---|---|
| ATLAS | autumn-sun-22098033 | https://console.neon.tech/app/projects/autumn-sun-22098033 |
| LM OpModel | long-frog-83686748 | https://console.neon.tech/app/projects/long-frog-83686748 |
| Nexus | still-truth-31614363 | https://console.neon.tech/app/projects/still-truth-31614363 |

1. Open the project link, click **SQL Editor** in the left menu.
2. At the top choose the **production branch** (the one marked default) and the database your app uses (usually `neondb`). Write the database name down.
3. In your password manager generate a 32-character password with letters and digits only. Keep it there. Do not type it anywhere else yet.
4. Open `docs/sql/dbarch-monitor-role.sql` (v2, least privilege; in the PR: https://github.com/1903978-prog/anti-hacker/blob/fix/dbarch-least-privilege/docs/sql/dbarch-monitor-role.sql), copy it into the SQL Editor and replace the two placeholders: `<PASSWORD>` (step 3) and `<DB_NAME>` (step 2). Click **Run**. Expected: no red error. The login can read ONLY key columns (ids, keys, foreign keys, migration version), no names, e-mails or notes, and not any table created later (re-run section 3 of the file after a schema change).
5. **Pre-merge check, needs no deploy and no password:** copy `docs/sql/dbarch-monitor-verify.sql` into the same editor and click **Run**. Expected: every row says PASS (two INFO rows are for reading). Any FAIL: stop and tell me the row text.
6. Build the connection string (keep it in your password manager):
   `postgresql://secval_monitor:PASSWORD@HOST/DB_NAME?sslmode=require`
   HOST: on the project page click **Connect**, switch **Connection pooling** off and copy only the host part (looks like `ep-name-12345.region.aws.neon.tech`). The `?sslmode=require` at the end is mandatory: secval refuses a remote connection without it.

## Part 2: store the three strings as Render secrets

1. Open https://dashboard.render.com, click the **secval** service, then **Environment**.
2. Click **Add Environment Variable** and add each one (Key, then Value = the matching connection string from step 6):
   - `SECVAL_DBARCH_URL_ATLAS`
   - `SECVAL_DBARCH_URL_LM_OP_MODEL`
   - `SECVAL_DBARCH_URL_NEXUS`
3. Look at the button next to Save: if the menu offers **Save only** (no deploy), use it; otherwise Save will restart secval once (about a minute; monitoring pauses briefly, not a code deploy). Render's exact wording could not be checked from the build sandbox: if only "Save, rebuild, and deploy" exists, stop and tell me. Nothing goes into GitHub or the code.
4. No Neon API token is needed or requested now.

## Part 3: test from the server

1. Open https://secval.onrender.com/#database and sign in as usual.
2. Click **Test connections**. Expected per app: "ready" with all steps "pass": secret set, URL format, TLS required, host resolves, port reachable, TLS login, effective permissions read-only.
3. If a step says FAIL it names the step (for example "no TCP connection from this server"). A FAIL on "effective permissions" means the login has a right it must not have; scans are refused until fixed.
4. Click **Deep Audit**. Expected: scores replace N/V where evidence exists, with last successful scan, coverage and any errors shown. Compare "Baseline counts" with the 05 Nov 2026 numbers.

Minimum reply to me: "Test connections: ATLAS ok / LM ok / Nexus ok" (or the FAIL line).

## Isolation

One login per Neon project and each Render variable holds one project's string, so ATLAS, LM OpModel and Nexus cannot read each other. Within a project the login has no rights on other databases (verify INFO row).
