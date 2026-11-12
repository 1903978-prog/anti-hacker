/**
 * Reassessment record: computes today's EEES scores and appends one history
 * row per app to its evidence file (date, assured, raw, coverage). The
 * dashboard's trend compares with the newest earlier row. Idempotent per day:
 * a second run on the same day replaces that day's row.
 *
 * Cadence (eees/v1.0/STANDARD.md section 9): daily, weekly or monthly; checks
 * whose evidence is older than their cadence fall back to UNKNOWN by
 * themselves, so a missed reassessment lowers the score instead of hiding.
 * Run: npm run eees:record            (all apps)
 *      npm run eees:record -- atena   (one app)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EEES_DIR, eeesView, loadRegistry } from "../../server/eees/registry.js";

const only = process.argv[2];
const reg = loadRegistry();
const view = eeesView(null);
const today = new Date().toISOString().slice(0, 10);
for (const app of reg.apps.apps) {
  if (only && app.id !== only) continue;
  const score = view.apps.find((a) => a.id === app.id);
  if (!score || !reg.evidence.has(app.id)) continue;
  const path = join(EEES_DIR, app.evidence);
  const file = JSON.parse(readFileSync(path, "utf8")) as { history?: Array<{ date: string }> };
  const history = (file.history ?? []).filter((h) => h.date.slice(0, 10) !== today);
  history.push({ date: today, assured: score.assured, raw: score.raw, coverage: score.coverage, standardVersion: reg.criteria.version } as never);
  file.history = history;
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  console.log(`eees: ${app.id} ${today} assured ${score.assured} coverage ${score.coverage}%`);
}
console.log(`ESII ${view.portfolio.esii} (live Secval monitors are not included in recorded history)`);
