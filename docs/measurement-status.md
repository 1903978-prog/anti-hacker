# Measurement status (public, on /health)

`GET /health` includes a `measurement` block so anyone can check, without a token, that secval is wired to every app. Nothing in it is secret.

| Field | Meaning |
|---|---|
| `commit` | First 12 characters of the live build (`RENDER_GIT_COMMIT`), or null. |
| `dbCheckTokenSet` | `SECVAL_DBCHECK_TOKEN` is configured (yes/no; the value is never shown). |
| `qualityTokenApps` | App names that have a quality token in `SECVAL_QUALITY_TOKENS` (names only). |
| `databases[]` | For each proven app: time of the last database check and a coarse outcome: `measured`, `refused` (401/403: tokens differ), `stale`, `bad-answer`, `unreachable`, `none` (never answered, or the app has no report yet: 404). |
| `quality[]` | For each app with a quality token: time of the last data-quality run received. |

Scores, rule notes and error text stay behind the API token, so the public page does not reveal an app's weaknesses. Code: `server/health/measurement.ts`. Tests: `test/measurement.test.ts`.
