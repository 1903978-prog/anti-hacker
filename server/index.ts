import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { startScheduler } from "./schedule/weekly.js";
import { startUptimeChecker } from "./health/uptime.js";

const db = openDb();
const app = createApp(db, { apiToken: process.env.SECVAL_API_TOKEN });
const port = Number(process.env.PORT ?? 3000);

if (!process.env.SECVAL_API_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn(
    "secval: SECVAL_API_TOKEN is not set — state-changing API requests will be refused (403/503). Set it to enable the control plane.",
  );
}

// Weekly automatic sweep (Monday 08:00 Europe/Paris). In-process timer; see
// README for the Render always-on caveat.
startScheduler(db);
// Health dashboard: check each proven app's home page every 30 minutes.
startUptimeChecker(db);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`secval listening on :${port}`);
});
