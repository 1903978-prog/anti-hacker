/**
 * Pre-merge, standalone test of the database scorecard. No deployment and no
 * secval server needed; it never writes to a monitored database or to secval's
 * real store (it uses a throwaway in-memory store).
 *
 *   SECVAL_DBARCH_URL_ATLAS=... SECVAL_DBARCH_URL_LM_OP_MODEL=... SECVAL_DBARCH_URL_NEXUS=... \
 *     npx tsx scripts/dbarch-preflight.ts [output-folder]
 *
 * Per configured app it runs: secret set -> URL/TLS -> DNS -> TCP -> TLS login (read-only
 * session) -> effective permissions -> a full Deep scan into memory. It prints pass/FAIL
 * lines and scores (no secrets, no SQL, no data) and writes the least-privilege column
 * GRANT script to <output-folder>/dbarch-grants-<app>.sql for the owner to review.
 * Exit code 1 if any configured app fails a stage.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../server/db.js";
import { APPS } from "../server/dbarch/apps.js";
import { pgConnector } from "../server/dbarch/connect.js";
import { testConnectivity } from "../server/dbarch/connectivity.js";
import { runScan, type AppResult } from "../server/dbarch/engine.js";
import { grantsSql } from "../server/dbarch/grants.js";
import { getLatest } from "../server/dbarch/store.js";
import type { AppKey } from "../server/dbarch/types.js";

const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });
const mark = (ok: boolean | null) => (ok === null ? "N/V " : ok ? "pass" : "FAIL");

async function main(): Promise<void> {
  const db = openDb(":memory:");
  let configured = 0;
  let failed = 0;
  const deps = { env: process.env, connect: pgConnector, now: () => new Date() };
  for (const app of Object.keys(APPS) as AppKey[]) {
    console.log(`\n== ${APPS[app].label} ==`);
    const rep = await testConnectivity(app, process.env, pgConnector);
    for (const s of rep.stages) console.log(`  [${mark(s.ok)}] ${s.label}${s.ok === true ? "" : ` - ${s.detail}`}`);
    if (rep.stages[0]?.ok === false) { console.log("  (not configured, skipped)"); continue; }
    configured++;
    for (const p of rep.permissions?.checks ?? []) console.log(`  [${mark(p.ok)}] permission: ${p.label} (${p.detail})`);
    if (!rep.ok) { failed++; continue; }
    const r = await runScan(db, app, "deep", deps);
    if (r.status === "error" || r.status === "skipped" || r.status === "unconfigured") { console.log(`  [FAIL] scan: ${r.message}`); failed++; continue; }
    const d = getLatest(db, app)!.result as unknown as AppResult;
    const a = d.architecture, q = d.readiness;
    console.log(`  scan ${r.status}: architecture ${a.score ?? "N/V"}/10 (coverage ${Math.round(a.coverage * 100)}%), readiness ${q.score ?? "N/V"}/10 (coverage ${Math.round(q.coverage * 100)}%)`);
    console.log(`  tables ${d.catalog.tables}, PKs ${d.catalog.primaryKeys}, FKs ${d.catalog.foreignKeys}, indexes ${d.catalog.indexes}, _id columns without FK ${d.catalog.idColumnsWithoutFk}`);
    const unverified = d.checks.filter((c) => c.outcome === "UNVERIFIED").length;
    console.log(`  orphan checks: ${d.checks.length} defined, ${d.checks.filter((c) => c.outcome === "PASS").length} pass, ${d.checks.filter((c) => c.outcome === "FAIL").length} fail, ${unverified} not verifiable yet (no column grant / unclassified)`);
    const file = join(out, `dbarch-grants-${app}.sql`);
    writeFileSync(file, grantsSql(d.grants, new Date().toISOString().slice(0, 10)));
    console.log(`  least-privilege column grants written to ${file} (${d.grants.columns.length} columns; review before running)`);
  }
  console.log(`\n${configured} app(s) tested, ${failed} failed.${configured === 0 ? " Set the SECVAL_DBARCH_URL_* variables first." : ""}`);
  process.exit(failed || configured === 0 ? 1 : 0);
}
main().catch(() => { console.error("preflight crashed (details withheld to avoid leaking secrets)"); process.exit(1); });
