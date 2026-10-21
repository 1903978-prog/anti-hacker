/**
 * Browser page check: opens secval's own page in Chromium with sample data
 * (the health reports kept in reports/), signs in, and on every tab checks
 *   - no sideways scrolling at 1440, 390 and 360 px wide (light and dark),
 *   - no accessibility problems found by axe-core (WCAG 2 A/AA rules).
 * Uses a throwaway in-memory store; touches nothing live. Exits 1 on any
 * problem. Run with `npm run test:page`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { loadReportFiles } from "../server/health/seed.js";

const TOKEN = "page-check-token";
const TABS = ["health", "scans", "tests", "usage", "settings"];
const WIDTHS = [1440, 390, 360];
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

async function sideways(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) return `page is ${doc.scrollWidth}px wide in a ${doc.clientWidth}px window`;
    for (const w of Array.from(document.querySelectorAll<HTMLElement>(".tablewrap"))) {
      if (w.offsetParent && w.scrollWidth > w.clientWidth + 1) {
        return `dashboard table needs sideways scrolling (${w.scrollWidth}px in ${w.clientWidth}px)`;
      }
    }
    return null;
  });
}

async function axe(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] });
    return r.violations.map(
      (v: { id: string; impact: string; nodes: Array<{ target: string[] }> }) =>
        `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`,
    );
  });
  return result as string[];
}

async function main(): Promise<void> {
  const db = openDb(":memory:");
  const app = createApp(db, { apiToken: TOKEN }); // seeds the allowlist the reports attach to
  const loaded = loadReportFiles(db).filter((r) => r.loaded).length;
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch(
    process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  );
  const problems: string[] = [];
  let checks = 0;
  try {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of WIDTHS) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, bypassCSP: true });
        const page = await ctx.newPage();
        await page.goto(`${base}/#health`);
        await page.locator("#tokenInput").waitFor({ state: "visible" });
        await page.fill("#tokenInput", TOKEN);
        await page.click("#tokenSave");
        await page.locator("table.dash").waitFor();
        for (const tab of TABS) {
          await page.goto(`${base}/#${tab}`);
          await page.locator(`section[data-panel="${tab}"]`).waitFor({ state: "visible" });
          await page.waitForTimeout(700); // let the tab's data arrive
          if (tab === "tests") await page.locator(".trow").first().waitFor({ timeout: 5000 }).catch(() => {});
          const where = `${tab} @ ${width}px ${scheme}`;
          const wide = await sideways(page);
          if (wide) problems.push(`${where}: ${wide}`);
          for (const v of await axe(page)) problems.push(`${where}: ${v}`);
          checks++;
          if (tab === "health") {
            // Also check an app's opened details (scores, reasons, infrastructure).
            await page.locator("button.link[data-open]").first().click();
            await page.locator("#dashDetail .app").waitFor();
            const wideDetail = await sideways(page);
            if (wideDetail) problems.push(`${where} details: ${wideDetail}`);
            for (const v of await axe(page)) problems.push(`${where} details: ${v}`);
            if (process.env.PAGE_SHOTS) await page.screenshot({ path: `${process.env.PAGE_SHOTS}/health-${width}-${scheme}.png`, fullPage: true });
            checks++;
          }
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`page check: ${checks} page views (${TABS.length} tabs + app details x ${WIDTHS.join("/")} px x light/dark), ${loaded} sample reports`);
  if (problems.length) {
    console.log(`FAILED, ${problems.length} problem(s):\n` + [...new Set(problems)].join("\n"));
    process.exit(1);
  }
  console.log("passed: no sideways scrolling, no axe-core violations");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
