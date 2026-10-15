import type { DB } from "../db.js";
import { toHostname } from "../util/host.js";
import { getEntry } from "../ownership/allowlist.js";
import { isEngaged } from "./killswitch.js";
import { resolveLimits, type RequestedLimits, type ResourceLimits } from "./limits.js";
import { appendAudit } from "../audit/log.js";

export type ScanMode = "passive" | "active";

export interface ScanRequest {
  actor: string;
  target: string;
  mode: ScanMode;
  limits?: RequestedLimits;
}

export interface Decision {
  allowed: boolean;
  reason: string;
  host?: string;
  effectiveLimits?: ResourceLimits;
}

/**
 * The single gate every scan action must pass. It is independent of the
 * scanning code and cannot be bypassed or disabled by it: scanning code calls
 * requestApproval() and must not run unless it returns allowed=true.
 *
 * Fail-closed: any error, unknown state, or unmet condition denies the action.
 * Checks, in order:
 *   1. kill switch is not engaged
 *   2. target resolves to a valid host
 *   3. host is on the ownership allowlist
 *   4. ownership of the host is proven
 *   5. the requested mode is permitted for the host
 *   6. requested resource limits are within the hard caps
 * Every decision — allow or deny — is written to the audit trail.
 */
export function requestApproval(db: DB, req: ScanRequest): Decision {
  try {
    if (isEngaged(db)) {
      return denied(db, req, "kill switch is engaged");
    }

    const host = toHostname(req.target);
    if (!host) {
      return denied(db, req, "target is not a valid host");
    }

    if (req.mode !== "passive" && req.mode !== "active") {
      return denied(db, { ...req, target: host }, `unknown mode '${req.mode}'`, host);
    }

    const entry = getEntry(db, host);
    if (!entry) {
      return denied(db, { ...req, target: host }, "target is not on the allowlist", host);
    }
    if (!entry.ownershipProven) {
      return denied(db, { ...req, target: host }, "ownership of target is not proven", host);
    }

    // Mode permission: passive is allowed on any proven target; active
    // requires the domain to be explicitly marked active-eligible.
    if (req.mode === "active" && !entry.activeEligible) {
      return denied(
        db,
        { ...req, target: host },
        "active mode is not permitted for this target",
        host,
      );
    }

    const limitCheck = resolveLimits(req.limits);
    if (!limitCheck.ok) {
      return denied(db, { ...req, target: host }, limitCheck.reason ?? "limits exceeded", host);
    }

    appendAudit(db, {
      actor: req.actor,
      action: "scan.approve",
      target: host,
      mode: req.mode,
      decision: "allow",
      reason: "approved",
      detail: { limits: limitCheck.effective },
    });
    return {
      allowed: true,
      reason: "approved",
      host,
      effectiveLimits: limitCheck.effective,
    };
  } catch (err) {
    // Any unexpected failure denies the action (fail closed). Best-effort log.
    try {
      appendAudit(db, {
        actor: req.actor ?? "unknown",
        action: "scan.approve",
        target: req.target ?? null,
        mode: req.mode ?? null,
        decision: "deny",
        reason: `policy engine error: ${(err as Error).message}`,
      });
    } catch {
      /* swallow: denial stands regardless of logging outcome */
    }
    return { allowed: false, reason: "policy engine error (failed closed)" };
  }
}

function denied(db: DB, req: ScanRequest, reason: string, host?: string): Decision {
  appendAudit(db, {
    actor: req.actor,
    action: "scan.approve",
    target: host ?? req.target,
    mode: req.mode,
    decision: "deny",
    reason,
  });
  return { allowed: false, reason, host };
}
