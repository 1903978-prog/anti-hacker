import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { startScheduler } from "./schedule/weekly.js";
import { startUptimeChecker } from "./health/uptime.js";
import { loadReportFiles } from "./health/seed.js";
import { startRestoreDrill } from "./backup/drill.js";
import { startIntegrityWatch } from "./integrity.js";

const db = openDb();
const app = createApp(db, { apiToken: process.env.SECVAL_API_TOKEN });
const port = Number(process.env.PORT ?? 3000);

if (!process.env.SECVAL_API_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn(
    "secval: SECVAL_API_TOKEN is not set — state-changing API requests will be refused (403/503). Set it to enable the control plane.",
  );
}

// Check the store is intact (corruption, broken links, schema version) at
// start and daily; the result shows on /health and /health/store.
startIntegrityWatch(db);
// Weekly automatic sweep (Monday 08:00 Europe/Paris). In-process timer; a
// sweep missed while the free tier slept runs within a minute of waking.
startScheduler(db);
// Health dashboard: check each proven app's home page every 30 minutes.
startUptimeChecker(db);
// Backup: restore the Backblaze copy into a scratch file daily and check it.
startRestoreDrill(db);
// Health reports kept in the repo (reports/*-health.md) appear as estimates.
for (const r of loadReportFiles(db)) {
  // eslint-disable-next-line no-console
  console.log(`secval: report ${r.file} -> ${r.host ?? "?"}: ${r.loaded ? "loaded" : r.reason}`);
}

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`secval listening on :${port}`);
});
