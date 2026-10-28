import compression from "compression";
import express, { type Express, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DB } from "./db.js";
import {
  addDomain,
  getEntry,
  listAllowlist,
  removeDomain,
  seedAllowlist,
  setActiveEligible,
} from "./ownership/allowlist.js";
import { createChallenge, verifyOwnership, type ProofMethod } from "./ownership/proof.js";
import { appendAudit, listAudit } from "./audit/log.js";
import { engage, isEngaged, release } from "./governance/killswitch.js";
import { requestApproval, type ScanMode } from "./governance/policy.js";
import { getFindings, listScans, runPassiveScan } from "./scan/passive.js";
import { runActiveScan } from "./scan/active.js";
import { checkReport } from "./scan/catalogue.js";
import { apiAuth, failedAuthLimiter, noStore, rateLimit, securityHeaders, sessionRoutes } from "./middleware.js";
import { dashboard } from "./health/score.js";
import { dashboardHosts, guessApp, listEstimates, saveReport } from "./health/report.js";
import { checkAllUptime } from "./health/uptime.js";
import { allUsage } from "./usage/providers.js";
import { previewDigest } from "./notify/daily.js";

export interface AppOptions {
  /** Secret token required for every API request (bearer header or sign-in cookie). */
  apiToken?: string;
  /** Render API caller; tests hand in canned answers. */
  renderFetch?: RenderFetcher;
  /** Environment for the Render rollback (defaults to process.env). */
  renderEnv?: Record<string, string | undefined>;
}
import { DEFAULT_WEEKLY, getLastRun, runWeeklySweep } from "./schedule/weekly.js";
import { backupMode, backupStatus, runRestoreDrill } from "./backup/drill.js";
import { dropboxStatus } from "./backup/dropbox.js";
import { lastIntegrity, refreshIntegrity } from "./integrity.js";
import { listDeploys, rollbackTo, type RenderFetcher } from "./deploy/rollback.js";

// Until a real auth layer exists, the actor is a fixed operator identity.
// Every governance action is still attributed in the audit trail.
const ACTOR = "operator";

/**
 * Builds the Express app. During Phase 1 the only scan-facing endpoint is a
 * dry-run that asks the policy engine for approval and runs nothing — it
 * exists to prove the gate is wired in. No real scanning capability exists
 * yet (Phase 2).
 */
export function createApp(db: DB, options: AppOptions = {}): Express {
  seedAllowlist(db);
  const apiToken = options.apiToken ?? process.env.SECVAL_API_TOKEN;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true); // behind Render's proxy; needed for correct req.ip
  app.use(securityHeaders());
  // Smaller pages and scripts: the first visit after a cold start is the slow one.
  app.use(compression());
  app.use(express.json({ limit: "32kb" }));

  // Control-plane protection: rate limit all API traffic, and require a bearer
  // token for every API request, reads included (scans, allowlist, audit, …).
  app.use("/api", rateLimit({ windowMs: 60_000, max: 120 }));
  app.use("/api", noStore());
  const wrongTokens = failedAuthLimiter({ windowMs: 60_000, max: 10 });
  app.use("/api", sessionRoutes(apiToken, wrongTokens));
  app.use("/api", apiAuth(apiToken, wrongTokens));

  // Public liveness check (for the uptime pinger): always 200 while the
  // server runs. `store` is the last integrity check of the database (yes/no
  // and counts only, never data).
  app.get("/health", (_req, res) => {
    const s = lastIntegrity(db);
    res.json({
      ok: true,
      killSwitch: isEngaged(db) ? "engaged" : "released",
      store: { ok: s.ok, checkedAt: s.at, schemaVersion: s.schemaVersion, brokenLinks: s.brokenLinks },
    });
  });

  // Store check for a monitor: 200 when the database is intact, 503 when not.
  // Re-runs the check at most once a minute (read-only), so a flood of
  // requests cannot keep the store busy.
  app.get("/health/store", (_req, res) => {
    const prev = lastIntegrity(db);
    const s = Date.now() - Date.parse(prev.at) > 60_000 ? refreshIntegrity(db) : prev;
    res.status(s.ok ? 200 : 503).json(s);
  });

  // --- Allowlist management -------------------------------------------------
  app.get("/api/allowlist", (_req, res) => {
    res.json(listAllowlist(db));
  });

  app.post("/api/allowlist", (req, res) => {
    const body = z.object({ domain: z.string(), notes: z.string().optional() }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error.message);
    const host = addDomain(db, body.data.domain, ACTOR, body.data.notes);
    if (!host) return badRequest(res, "invalid domain");
    res.status(201).json(getEntry(db, host));
  });

  app.delete("/api/allowlist/:domain", (req, res) => {
    const ok = removeDomain(db, req.params.domain, ACTOR);
    res.status(ok ? 200 : 404).json({ removed: ok });
  });

  app.post("/api/allowlist/:domain/active-eligible", (req, res) => {
    const body = z.object({ eligible: z.boolean() }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error.message);
    const ok = setActiveEligible(db, req.params.domain, body.data.eligible, ACTOR);
    if (!ok) return badRequest(res, "domain unknown or ownership not proven");
    res.json(getEntry(db, req.params.domain));
  });

  // --- Proof of ownership ---------------------------------------------------
  app.post("/api/allowlist/:domain/challenge", (req, res) => {
    const challenge = createChallenge(db, req.params.domain, ACTOR);
    if (!challenge) return badRequest(res, "domain not on allowlist");
    res.json({
      ...challenge,
      instructions: {
        "dns-txt": `Create a TXT record at _secval-challenge.${challenge.host} containing: ${challenge.token}`,
        "token-file": `Place the token at https://${challenge.host}/.well-known/secval-challenge.txt`,
      },
    });
  });

  app.post("/api/allowlist/:domain/verify", async (req, res) => {
    const body = z.object({ method: z.enum(["dns-txt", "token-file"]) }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error.message);
    const result = await verifyOwnership(db, req.params.domain, body.data.method as ProofMethod, ACTOR);
    res.status(result.verified ? 200 : 422).json(result);
  });

  // --- Audit trail ----------------------------------------------------------
  app.get("/api/audit", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
    res.json(listAudit(db, limit));
  });

  // --- Kill switch ----------------------------------------------------------
  app.post("/api/kill-switch/engage", (req, res) => {
    engage(db, ACTOR, typeof req.body?.reason === "string" ? req.body.reason : undefined);
    res.json({ killSwitch: "engaged" });
  });

  app.post("/api/kill-switch/release", (_req, res) => {
    release(db, ACTOR);
    res.json({ killSwitch: "released" });
  });

  // --- Scan approval (dry-run gate: asks the engine, runs nothing) ----------
  app.post("/api/scan/preflight", (req, res) => {
    const body = z
      .object({
        target: z.string(),
        mode: z.enum(["passive", "active"]).default("passive"),
      })
      .safeParse(req.body);
    if (!body.success) return badRequest(res, body.error.message);
    const decision = requestApproval(db, {
      actor: ACTOR,
      target: body.data.target,
      mode: body.data.mode as ScanMode,
    });
    res.status(decision.allowed ? 200 : 403).json(decision);
  });

  // --- Passive scan (gated; passive reads only) -----------------------------
  app.post("/api/scan", async (req, res) => {
    const body = z.object({ target: z.string() }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error.message);
    const result = await runPassiveScan(db, { actor: ACTOR, target: body.data.target });
    const status = result.status === "completed" ? 200 : result.status === "denied" ? 403 : 502;
    res.status(status).json(result);
  });

  // --- Active scan (gated; active-eligible targets only; GET-only probes) ---
  app.post("/api/scan/active", async (req, res) => {
    const body = z
      .object({ target: z.string(), loginPath: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return badRequest(res, body.error.message);
    const result = await runActiveScan(db, {
      actor: ACTOR,
      target: body.data.target,
      loginPath: body.data.loginPath,
    });
    const status = result.status === "completed" ? 200 : result.status === "denied" ? 403 : 502;
    res.status(status).json(result);
  });

  app.get("/api/scans", (_req, res) => {
    res.json(listScans(db));
  });

  app.get("/api/scans/:id/findings", (req, res) => {
    res.json(getFindings(db, req.params.id));
  });

  // --- All tests: every check per app, pass / fail / not run (read-only) ---
  app.get("/api/tests", (_req, res) => {
    res.json(dashboardHosts(db).map((h) => h.host));
  });

  app.get("/api/tests/:host", (req, res) => {
    const host = req.params.host;
    if (!dashboardHosts(db).some((h) => h.host === host)) return badRequest(res, "unknown app");
    res.json(checkReport(db, host));
  });

  // --- Backup (status and restore drill) -------------------------------------
  app.get("/api/backup", (_req, res) => {
    res.json(backupStatus(db));
  });

  app.post("/api/backup/drill", async (_req, res) => {
    if (backupMode() !== "on") {
      res.status(409).json({ error: "Backup is not running, so there is nothing to test." });
      return;
    }
    res.json(await runRestoreDrill(db, ACTOR));
  });

  // Dropbox copies of each app's code and database (read-only check).
  app.get("/api/backup/dropbox", async (req, res) => {
    res.json(await dropboxStatus({ refresh: req.query.refresh === "1" }));
  });

  // --- Rollback (recent Render deploys, one-click rollback) -------------------
  app.get("/api/deploys", async (_req, res) => {
    res.json(await listDeploys(options.renderEnv ?? process.env, options.renderFetch));
  });

  app.post("/api/rollback", async (req, res) => {
    const body = z.object({ deployId: z.string().max(80) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "deployId is required" });
      return;
    }
    const result = await rollbackTo(body.data.deployId, options.renderEnv ?? process.env, options.renderFetch);
    appendAudit(db, {
      actor: ACTOR,
      action: "rollback",
      target: body.data.deployId,
      decision: result.ok ? "allow" : "deny",
      reason: result.message,
      detail: result.deploy ? { commit: result.deploy.commit, status: result.deploy.status } : null,
    });
    res.status(result.ok ? 200 : 409).json(result);
  });

  // --- Schedule (weekly automatic sweep) ------------------------------------
  app.get("/api/schedule", (_req, res) => {
    res.json({
      ...DEFAULT_WEEKLY,
      description: `Every ${DEFAULT_WEEKLY.weekday} at ${String(DEFAULT_WEEKLY.hour).padStart(2, "0")}:00 ${DEFAULT_WEEKLY.timeZone}`,
      lastRun: getLastRun(db),
    });
  });

  app.post("/api/schedule/run-now", async (_req, res) => {
    const result = await runWeeklySweep(db, ACTOR);
    res.json(result);
  });

  // --- Health dashboard -----------------------------------------------------
  app.get("/api/dashboard", (_req, res) => {
    res.json(dashboard(db));
  });

  app.get("/api/dashboard/history/:host", (req, res) => {
    res.json(listEstimates(db, req.params.host));
  });

  app.post("/api/dashboard/guess", (req, res) => {
    const body = z.object({ text: z.string().max(20_000) }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error.message);
    res.json({ host: guessApp(db, body.data.text) });
  });

  app.post("/api/dashboard/report", (req, res) => {
    const body = z.object({ app: z.string(), text: z.string().max(20_000) }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error.message);
    const result = saveReport(db, body.data.app, body.data.text, ACTOR);
    if ("error" in result) return badRequest(res, result.error);
    res.status(201).json(result);
  });

  app.post("/api/dashboard/check-now", async (_req, res) => {
    const checks = await checkAllUptime(db);
    res.json({ checked: checks.length });
  });

  // --- Usage counters (GitHub, Render, Fly, Backblaze; read-only) ----------
  app.get("/api/usage", async (req, res) => {
    res.json(await allUsage({ refresh: req.query.refresh === "1" }));
  });

  // What tomorrow's daily e-mail would say, and whether e-mail is configured.
  app.get("/api/digest/preview", async (_req, res) => {
    res.json(await previewDigest(db));
  });

  // --- Static UI ------------------------------------------------------------
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  app.use(express.static(publicDir));

  // Last resort: one bad request answers 500 as JSON (no stack, no details)
  // and never takes the server down.
  app.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    // eslint-disable-next-line no-console
    console.error("secval: request failed:", err instanceof Error ? err.message : "unknown error");
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return app;
}

function badRequest(res: Response, message: string): Response {
  return res.status(400).json({ error: message });
}

export type { Request, Response };
