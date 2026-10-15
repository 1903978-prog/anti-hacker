import { openDb } from "./db.js";
import { createApp } from "./app.js";

const db = openDb();
const app = createApp(db);
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`secval listening on :${port}`);
});
