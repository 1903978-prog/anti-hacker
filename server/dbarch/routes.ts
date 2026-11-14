import type { Express } from "express";
import { z } from "zod";
import type { DB } from "../db.js";
import { APPS } from "./apps.js";
import { pgConnector } from "./connect.js";
import { checkStaleness, runAll, runScan, type Deps } from "./engine.js";
import { activeAttestations, addAttestation, getLatest, listAlerts, validAttestationKey } from "./store.js";
import { buildView } from "./view.js";
import { isEngaged } from "../governance/killswitch.js";
import { testConnectivity } from "./connectivity.js";
import { grantsSql } from "./grants.js";
import { appendAudit } from "../audit/log.js";
import { STALE_AFTER_MS } from "./apps.js";
import type { AppKey } from "./types.js";

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  return { connect: pgConnector, env, now: () => new Date() };
}

const appKey = z.enum(["atlas", "lm-op-model", "nexus"]);

export function dbarchRoutes(app: Express, db: DB, deps: Deps = defaultDeps()): void {
  app.get("/api/dbarch", (_req, res) => {
    checkStaleness(db, deps, STALE_AFTER_MS);
    res.json(buildView(db, deps.env, deps.now()));
  });

  // Manual Quick Refresh / Deep Audit. Read-only against the monitored DBs.
  app.post("/api/dbarch/refresh", async (req, res) => {
    const body = z.object({ mode: z.enum(["quick", "deep"]).default("quick"), app: appKey.optional() }).safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json({ error: "mode must be quick or deep" }); return; }
    const outcomes = body.data.app ? [await runScan(db, body.data.app, body.data.mode, deps)] : await runAll(db, body.data.mode, deps);
    res.json({ outcomes, view: buildView(db, deps.env, deps.now()) });
  });

  // One-click staged connection test from this server (DNS, TCP, TLS login, effective permissions). Read-only.
  app.post("/api/dbarch/connectivity", async (req, res) => {
    const b = z.object({ app: appKey.optional() }).safeParse(req.body ?? {});
    if (!b.success) { res.status(400).json({ error: "unknown app" }); return; }
    const keys = b.data.app ? [b.data.app] : (Object.keys(APPS) as AppKey[]);
    if (isEngaged(db)) {
      appendAudit(db, { actor: "operator", action: "dbarch.connectivity", decision: "deny", reason: "kill switch engaged" });
      res.status(423).json({ error: "Kill switch is on: connection test not run." });
      return;
    }
    const reports = [];
    for (const k of keys) reports.push(await testConnectivity(k, deps.env, deps.connect, deps.net, deps.now()));
    appendAudit(db, { actor: "operator", action: "dbarch.connectivity", decision: "info", reason: reports.map((x) => `${x.app}:${x.ok ? "ok" : "fail"}`).join(" ") });
    res.json({ reports });
  });

  // Full latest detail for one app (inventory, checks, recommendations with draft SQL proposals).
  app.get("/api/dbarch/:app/detail", (req, res) => {
    const k = appKey.safeParse(req.params.app);
    if (!k.success) { res.status(404).json({ error: "unknown app" }); return; }
    const latest = getLatest(db, k.data);
    if (!latest) { res.json({ app: k.data, detail: null, message: "No verified scan yet (N/V)." }); return; }
    res.json({ app: k.data, scanId: latest.scan_id, updatedAt: latest.updated_at, detail: latest.result });
  });

  // The exact least-privilege column GRANT script for the latest scan (plain text, to review and run as the table owner).
  app.get("/api/dbarch/:app/grants", (req, res) => {
    const k = appKey.safeParse(req.params.app);
    if (!k.success) { res.status(404).json({ error: "unknown app" }); return; }
    const latest = getLatest(db, k.data);
    const g = (latest?.result as { grants?: { columns: string[]; skipped: string[] } } | undefined)?.grants;
    if (!g) { res.json({ app: k.data, sql: null, message: "No verified scan yet (N/V): run a scan with the metadata-only login first." }); return; }
    res.json({ app: k.data, sql: grantsSql(g, deps.now().toISOString().slice(0, 10)), columns: g.columns.length, skipped: g.skipped });
  });

  app.get("/api/dbarch/alerts", (req, res) => {
    const k = appKey.safeParse(req.query.app);
    res.json(listAlerts(db, k.success ? (k.data as AppKey) : undefined, 100));
  });

  app.get("/api/dbarch/:app/attestations", (req, res) => {
    const k = appKey.safeParse(req.params.app);
    if (!k.success) { res.status(404).json({ error: "unknown app" }); return; }
    res.json([...activeAttestations(db, k.data, deps.now()).values()]);
  });

  // Human attestation / time-bound override. Never edits raw measurements; shown next to them.
  app.post("/api/dbarch/attest", (req, res) => {
    const b = z
      .object({
        app: appKey,
        key: z.string().refine(validAttestationKey, "unknown key"),
        value: z.number().min(0).max(10).nullable().default(null),
        detail: z.string().max(120).optional(),
        reason: z.string().min(5).max(500),
        expiresInDays: z.number().int().min(1).max(90),
      })
      .safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "invalid request", issues: b.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }); return; }
    const now = deps.now();
    addAttestation(db, { app: b.data.app, key: b.data.key, value: b.data.value, detail: b.data.detail ?? null, reason: b.data.reason, approvedBy: "operator", expiresAt: new Date(now.getTime() + b.data.expiresInDays * 86_400_000).toISOString() }, now.toISOString());
    res.status(201).json({ ok: true });
  });

  // keep APPS referenced for tooling that lists apps
  void APPS;
}
