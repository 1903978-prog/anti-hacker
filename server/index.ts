import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { startScheduler } from "./schedule/weekly.js";

const db = openDb();
const app = createApp(db);
const port = Number(process.env.PORT ?? 3000);

// Weekly automatic sweep (Monday 08:00 Europe/Paris). In-process timer; see
// README for the Render always-on caveat.
startScheduler(db);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`secval listening on :${port}`);
});
