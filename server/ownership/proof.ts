import { randomBytes } from "node:crypto";
import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import type { DB } from "../db.js";
import { toHostname } from "../util/host.js";
import { getEntry, markProven } from "./allowlist.js";
import { appendAudit } from "../audit/log.js";

export type ProofMethod = "dns-txt" | "token-file";

/** Where each proof method expects the token to appear. */
export const DNS_TXT_NAME = (host: string) => `_secval-challenge.${host}`;
export const TOKEN_FILE_PATH = "/.well-known/secval-challenge.txt";

export interface Verifiers {
  /** Resolves TXT records for a name (default: real DNS). */
  resolveTxt?: (name: string) => Promise<string[][]>;
  /** Fetches the token-file body for a host (default: real HTTPS GET). */
  fetchTokenFile?: (host: string) => Promise<string>;
}

/**
 * Issues (or re-issues) a per-domain challenge token. The caller places the
 * token in DNS or on the site, then verification checks for it. The domain
 * must already be on the allowlist.
 */
export function createChallenge(db: DB, input: string, actor: string): { host: string; token: string } | null {
  const entry = getEntry(db, input);
  if (!entry) return null;
  const token = "secval-" + randomBytes(16).toString("hex");
  db.prepare(`UPDATE allowlist SET proof_token = ? WHERE domain = ?`).run(token, entry.domain);
  appendAudit(db, {
    actor,
    action: "ownership.challenge_issued",
    target: entry.domain,
    decision: "info",
  });
  return { host: entry.domain, token };
}

async function realFetchTokenFile(host: string): Promise<string> {
  const res = await fetch(`https://${host}${TOKEN_FILE_PATH}`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, 4096);
}

/**
 * Verifies ownership of a domain using the chosen method and the previously
 * issued challenge token. On success the allowlist is marked proven. Fails
 * closed: any error, missing token, or mismatch returns verified=false.
 */
export async function verifyOwnership(
  db: DB,
  input: string,
  method: ProofMethod,
  actor: string,
  verifiers: Verifiers = {},
): Promise<{ verified: boolean; reason: string }> {
  const host = toHostname(input);
  if (!host) return { verified: false, reason: "invalid domain" };

  const entry = getEntry(db, host);
  if (!entry) return deny(db, host, method, actor, "domain not on allowlist");
  if (!entry.ownershipProven && !entry.provenAt) {
    // fall through — proving is the whole point
  }

  const expected = (
    db.prepare(`SELECT proof_token FROM allowlist WHERE domain = ?`).get(host) as
      | { proof_token: string | null }
      | undefined
  )?.proof_token;
  if (!expected) return deny(db, host, method, actor, "no challenge issued");

  try {
    if (method === "dns-txt") {
      const resolve = verifiers.resolveTxt ?? dnsResolveTxt;
      const records = await resolve(DNS_TXT_NAME(host));
      const flat = records.map((chunks) => chunks.join(""));
      if (!flat.includes(expected)) {
        return deny(db, host, method, actor, "TXT record not found");
      }
    } else if (method === "token-file") {
      const get = verifiers.fetchTokenFile ?? realFetchTokenFile;
      const body = await get(host);
      if (!body.includes(expected)) {
        return deny(db, host, method, actor, "token file did not match");
      }
    } else {
      return deny(db, host, method, actor, "unknown method");
    }
  } catch (err) {
    return deny(db, host, method, actor, `verification error: ${(err as Error).message}`);
  }

  markProven(db, host, method, actor);
  return { verified: true, reason: "ownership verified" };
}

function deny(
  db: DB,
  host: string,
  method: ProofMethod,
  actor: string,
  reason: string,
): { verified: false; reason: string } {
  appendAudit(db, {
    actor,
    action: "ownership.verify",
    target: host,
    mode: method,
    decision: "deny",
    reason,
  });
  return { verified: false, reason };
}
