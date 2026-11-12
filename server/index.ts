import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { startScheduler } from "./schedule/weekly.js";
import { startUptimeChecker } from "./health/uptime.js";
import { startDbChecker } from "./health/dbcheck.js";
import { loadReportFiles } from "./health/seed.js";
import { startCiWatch } from "./health/ci.js";
import { startRestoreDrill } from "./backup/drill.js";
import { startDropboxWatch } from "./backup/dropbox.js";
import { startIntegrityWatch } from "./integrity.js";
import { startLenovoMonitor } from "./lenovo/monitor.js";

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
// Database column: ask each proven app for its database report every hour.
startDbChecker(db);
// Backup: restore the Backblaze copy into a scratch file daily and check it.
startRestoreDrill(db);
// Dropbox: check daily that the PC backup left its Monday copies.
startDropboxWatch();
// GitHub build/deploy results cap Reliability and Deploy while a run is red.
startCiWatch();
// Lenovo 24/7 monitor: app status every minute, real self-test answers and 10bonds
// job throughput every 5 minutes, all through the policy gate (LENOVO_MONITOR=off stops it).
startLenovoMonitor(db);
// The daily health e-mail is OFF (Livio 28/10: not asked for). The text is still
// available at GET /api/digest/preview; startDailyDigest() must stay uncalled.
// Health reports kept in the repo (reports/*-health.md) appear as estimates.
for (const r of loadReportFiles(db)) {
  // eslint-disable-next-line no-console
  console.log(`secval: report ${r.file} -> ${r.host ?? "?"}: ${r.loaded ? "loaded" : r.reason}`);
}

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`secval listening on :${port}`);
});

// A forgotten promise error in a timer must not crash the server (Node would
// exit); log it and keep serving.
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("secval: unhandled promise error:", reason instanceof Error ? reason.message : "unknown");
});

// Render stops the old copy on every deploy: finish requests in flight, then
// exit so Litestream can send its last changes to the backup.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
});
