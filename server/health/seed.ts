import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db.js";
import { dashboardHosts, saveReport } from "./report.js";

/**
 * Loads the health reports kept in the repo's reports/ folder (one
 * "<app>-health.md" per app, plus "<app>-seo.md" for the SEO and GEO ratings) so the dashboard shows them without anyone
 * pasting them. Each is stored as an estimate, like a pasted report. A
 * report already loaded (same app, same text) is skipped, so restarts do
 * not duplicate it.
 */
export function loadReportFiles(
  db: DB,
  dir = join(process.cwd(), "reports"),
): Array<{ file: string; host: string | null; loaded: boolean; reason?: string }> {
  if (!existsSync(dir)) return [];
  const hosts = dashboardHosts(db);
  return readdirSync(dir)
    .filter((f) => /-(health|seo)\.md$/.test(f))
    .sort()
    .map((file) => {
      const name = file.replace(/-(health|seo)\.md$/, "");
      // Several rows can share a name (10bonds.com and 10bonds.fly.dev): an
      // exact host wins, then a proven row (the live app), then any match.
      const matches = hosts.filter((h) => h.host === name || h.host.split(".")[0]!.startsWith(name));
      const host =
        (matches.find((h) => h.host === name) ?? matches.find((h) => h.proven) ?? matches[0])?.host ?? null;
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
