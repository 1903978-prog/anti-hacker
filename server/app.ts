import express, { type Express, type Request, type Response } from "express";
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
import { listAudit } from "./audit/log.js";
import { engage, isEngaged, release } from "./governance/killswitch.js";
import { requestApproval, type ScanMode } from "./governance/policy.js";

// Until a real auth layer exists, the actor is a fixed operator identity.
// Every governance action is still attributed in the audit trail.
const ACTOR = "operator";

/**
 * Builds the Express app. During Phase 1 the only scan-facing endpoint is a
 * dry-run that asks the policy engine for approval and runs nothing — it
 * exists to prove the gate is wired in. No real scanning capability exists
 * yet (Phase 2).
 */
export function createApp(db: DB): Express {
  seedAllowlist(db);
  const app = express();
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, killSwitch: isEngaged(db) ? "engaged" : "released" });
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

  // --- Scan approval (dry-run gate; no scanning capability exists yet) -------
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

  return app;
}

function badRequest(res: Response, message: string): Response {
  return res.status(400).json({ error: message });
}

export type { Request, Response };
