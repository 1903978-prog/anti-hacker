import type { DB } from "../db.js";
import { toHostname } from "../util/host.js";
import { appendAudit } from "../audit/log.js";

export interface AllowlistEntry {
  domain: string;
  addedAt: string;
  notes: string | null;
  ownershipProven: boolean;
  ownershipMethod: string | null;
  provenAt: string | null;
  activeEligible: boolean;
}

/** Domains the platform ships pre-populated, all unproven until verified. */
export const SEED_DOMAINS = [
  "compplan.onrender.com",
  "nexus-eendigo.fly.dev",
  "lm-op-model.fly.dev",
  "eendigo.com",
  "10bonds.com",
] as const;

function rowToEntry(r: Record<string, unknown>): AllowlistEntry {
  return {
    domain: r.domain as string,
    addedAt: r.added_at as string,
    notes: (r.notes as string) ?? null,
    ownershipProven: Number(r.ownership_proven) === 1,
    ownershipMethod: (r.ownership_method as string) ?? null,
    provenAt: (r.proven_at as string) ?? null,
    activeEligible: Number(r.active_eligible) === 1,
  };
}

/** Inserts the seed domains if they are not already present. Idempotent. */
export function seedAllowlist(db: DB): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO allowlist (domain, added_at, notes) VALUES (?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const d of SEED_DOMAINS) insert.run(d, now, "seeded");
  });
  tx();
}

export function listAllowlist(db: DB): AllowlistEntry[] {
  const rows = db
    .prepare(`SELECT * FROM allowlist ORDER BY domain`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

export function getEntry(db: DB, input: string): AllowlistEntry | null {
  const host = toHostname(input);
  if (!host) return null;
  const row = db.prepare(`SELECT * FROM allowlist WHERE domain = ?`).get(host) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEntry(row) : null;
}

/** Adds a domain to the allowlist (unproven). Returns the normalized host. */
export function addDomain(db: DB, input: string, actor: string, notes?: string): string | null {
  const host = toHostname(input);
  if (!host) return null;
  db.prepare(
    `INSERT OR IGNORE INTO allowlist (domain, added_at, notes) VALUES (?, ?, ?)`,
  ).run(host, new Date().toISOString(), notes ?? null);
  appendAudit(db, { actor, action: "allowlist.add", target: host, decision: "info" });
  return host;
}

export function removeDomain(db: DB, input: string, actor: string): boolean {
  const host = toHostname(input);
  if (!host) return false;
  const info = db.prepare(`DELETE FROM allowlist WHERE domain = ?`).run(host);
  if (info.changes > 0) {
    appendAudit(db, { actor, action: "allowlist.remove", target: host, decision: "info" });
    return true;
  }
  return false;
}

/** Records proven ownership for a domain. Called by the proof verifier only. */
export function markProven(db: DB, host: string, method: string, actor: string): void {
  db.prepare(
    `UPDATE allowlist SET ownership_proven = 1, ownership_method = ?, proven_at = ?
     WHERE domain = ?`,
  ).run(method, new Date().toISOString(), host);
  appendAudit(db, {
    actor,
    action: "ownership.proven",
    target: host,
    decision: "info",
    reason: `verified via ${method}`,
  });
}

/**
 * Sets whether a domain is eligible for active (non-passive) scanning. A
 * domain can only become active-eligible once ownership is proven; the flag
 * is forced off otherwise.
 */
export function setActiveEligible(db: DB, input: string, eligible: boolean, actor: string): boolean {
  const entry = getEntry(db, input);
  if (!entry) return false;
  if (eligible && !entry.ownershipProven) {
    appendAudit(db, {
      actor,
      action: "allowlist.set_active_eligible",
      target: entry.domain,
      decision: "deny",
      reason: "cannot be active-eligible before ownership is proven",
    });
    return false;
  }
  db.prepare(`UPDATE allowlist SET active_eligible = ? WHERE domain = ?`).run(
    eligible ? 1 : 0,
    entry.domain,
  );
  appendAudit(db, {
    actor,
    action: "allowlist.set_active_eligible",
    target: entry.domain,
    decision: "info",
    reason: `active_eligible=${eligible}`,
  });
  return true;
}
