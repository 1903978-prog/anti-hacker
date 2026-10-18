import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db.js";
import { dashboardHosts, saveReport } from "./report.js";

/**
 * Loads the health reports kept in the repo's reports/ folder (one
 * "<app>-health.md" per app) so the dashboard shows them without anyone
 * pasting them. Each is stored as an estimate, like a pasted report. A
 * report already loaded (same app, same text) is skipped, so restarts do
 * not duplicate it.
 */
export function loadReportFiles(
  db: DB,
  dir = join(process.cwd(), "reports"),
): Array<{ file: string; host: string | null; loaded: boolean; reason?: string }> {
  if (!existsSync(dir)) return [];
  const hosts = dashboardHosts(db).map((h) => h.host);
  return readdirSync(dir)
    .filter((f) => f.endsWith("-health.md"))
    .sort()
    .map((file) => {
      const name = file.replace(/-health\.md$/, "");
      const host = hosts.find((h) => h.split(".")[0]!.startsWith(name)) ?? null;
      if (!host) return { file, host, loaded: false, reason: "no matching app" };
      const text = readFileSync(join(dir, file), "utf8");
      const already = db
        .prepare(`SELECT 1 FROM health_reports WHERE host = ? AND text = ?`)
        .get(host, text.slice(0, 20_000));
      if (already) return { file, host, loaded: false, reason: "already loaded" };
      const result = saveReport(db, host, text, "reports-folder");
      return "error" in result
        ? { file, host, loaded: false, reason: result.error }
        : { file, host, loaded: true };
    });
}
