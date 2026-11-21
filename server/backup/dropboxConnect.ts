import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "../db.js";
import { appendAudit } from "../audit/log.js";
import { clearDropboxCache, setStoredRefreshToken, type Env } from "./dropbox.js";

/**
 * "Reconnect Dropbox" (21 Nov 2026): Livio presses one button on the Backup page, says "Allow" on
 * Dropbox's own page, and secval keeps the new Dropbox key itself. Before, a new key meant
 * hand-made OAuth calls and an edit in a Render account no session can open.
 *
 * Safety:
 * - Only a logged-in owner can start it (POST /api/backup/dropbox/reconnect). The start makes a
 *   one-time random "state", kept only as a hash, valid 10 minutes, used once. Dropbox sends it
 *   back to GET /dropbox/callback; a callback without the matching state does nothing.
 *   (The callback cannot rely on the login cookie: it is SameSite=Strict, so a browser does not
 *   send it on the redirect from dropbox.com.)
 * - The code is exchanged with the app key and secret already in Render (DROPBOX_APP_KEY and
 *   DROPBOX_APP_SECRET). The new key is stored encrypted (AES-256-GCM, key derived from
 *   DROPBOX_APP_SECRET) in app_state; it is never logged, returned to a page or put in the audit trail.
 *   Without the app secret the stored key is useless anyway.
 * - The Dropbox key in Render (DROPBOX_REFRESH_TOKEN) is not changed. The stored key is used
 *   instead of it for the read-only backup check only; nothing is deleted. Reconnecting again
 *   replaces the stored key.
 */

const PENDING_KEY = "dropbox.reconnect.pending";
const TOKEN_KEY = "dropbox.reconnect.token";
const LAST_KEY = "dropbox.reconnect.last";
const STATE_TTL_MS = 10 * 60_000;
export const CALLBACK_PATH = "/dropbox/callback";

export interface ReconnectResult {
  ok: boolean;
  at: string;
  detail: string;
  /** Permissions Dropbox granted to the new key (names only). */
  scopes?: string[];
}

type TokenFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) =>
  Promise<{ status: number; json(): Promise<unknown> }>;

const realFetch: TokenFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

function getState(db: DB, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function putState(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function encKey(env: Env): Buffer | null {
  const secret = env.DROPBOX_APP_SECRET;
  if (!secret) return null;
  return Buffer.from(hkdfSync("sha256", secret, "secval", "dropbox-refresh-v1", 32));
}

export function sealToken(token: string, env: Env): string | null {
  const key = encKey(env);
  if (!key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function openToken(sealed: string, env: Env): string | null {
  const key = encKey(env);
  if (!key) return null;
  try {
    const s = JSON.parse(sealed) as { v: number; iv: string; tag: string; data: string };
    if (s.v !== 1 || Buffer.from(s.tag, "base64").length !== 16 || Buffer.from(s.iv, "base64").length !== 12) return null;
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
  } catch {
    return null; // wrong app secret or damaged value: fall back to the key in Render
  }
}

/** At start: use the key stored by an earlier reconnect, if any (and readable with the current app secret). */
export function loadStoredToken(db: DB, env: Env = process.env): boolean {
  const sealed = getState(db, TOKEN_KEY);
  const token = sealed ? openToken(sealed, env) : null;
  setStoredRefreshToken(token);
  return !!token;
}

export function lastReconnect(db: DB): ReconnectResult | null {
  const v = getState(db, LAST_KEY);
  try {
    return v ? (JSON.parse(v) as ReconnectResult) : null;
  } catch {
    return null;
  }
}

/** Starts a reconnect: returns Dropbox's consent page address, or why it cannot start. */
export function startReconnect(
  db: DB,
  publicOrigin: string,
  env: Env = process.env,
  now: Date = new Date(),
): { ok: true; url: string } | { ok: false; error: string } {
  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET)
    return { ok: false, error: "Dropbox is not set up in secval (DROPBOX_APP_KEY and DROPBOX_APP_SECRET are needed)." };
  const state = randomBytes(32).toString("base64url");
  const redirectUri = publicOrigin.replace(/\/+$/, "") + CALLBACK_PATH;
  putState(db, PENDING_KEY, JSON.stringify({
    stateHash: sha256(state).toString("hex"),
    redirectUri,
    expiresAt: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  }));
  const q = new URLSearchParams({
    client_id: env.DROPBOX_APP_KEY,
    response_type: "code",
    token_access_type: "offline",
    redirect_uri: redirectUri,
    state,
  });
  return { ok: true, url: `https://www.dropbox.com/oauth2/authorize?${q.toString()}` };
}

function record(db: DB, r: ReconnectResult): ReconnectResult {
  putState(db, LAST_KEY, JSON.stringify(r));
  appendAudit(db, {
    actor: "operator",
    action: "backup.dropbox_reconnect",
    decision: r.ok ? "allow" : "deny",
    reason: r.detail,
    detail: { ok: r.ok, scopes: r.scopes ?? null },
  });
  return r;
}

/** Handles Dropbox's redirect back. Never throws; records the outcome (never the key). */
export async function finishReconnect(
  db: DB,
  q: { code?: unknown; state?: unknown; error?: unknown },
  env: Env = process.env,
  f: TokenFetch = realFetch,
  now: Date = new Date(),
): Promise<ReconnectResult> {
  const at = now.toISOString();
  const fail = (detail: string) => record(db, { ok: false, at, detail });
  const raw = getState(db, PENDING_KEY);
  let pending: { stateHash: string; redirectUri: string; expiresAt: string } | null = null;
  try {
    pending = raw ? JSON.parse(raw) : null;
  } catch {
    pending = null;
  }
  const state = typeof q.state === "string" ? q.state : "";
  const given = sha256(state);
  const expected = pending?.stateHash ? Buffer.from(pending.stateHash, "hex") : Buffer.alloc(0);
  // Not started on this page (or already used): anyone can call this address, so nothing is
  // recorded or changed, not even the audit trail or the last result shown on the page.
  if (!pending || !state || expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, at, detail: "Reconnect refused: the link did not come from a reconnect started on this page." };
  // One use only, whatever happens next.
  putState(db, PENDING_KEY, JSON.stringify({ used: at }));
  if (Date.parse(pending.expiresAt) < now.getTime())
    return fail("Reconnect expired (more than 10 minutes). Press Reconnect Dropbox again.");
  if (typeof q.error === "string" && q.error)
    return fail(q.error === "access_denied" ? "Dropbox access was not allowed, so nothing changed." : "Dropbox stopped the reconnect, so nothing changed.");
  if (typeof q.code !== "string" || !q.code || q.code.length > 512) return fail("Dropbox sent no code, so nothing changed.");
  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) return fail("Dropbox is not set up in secval, so nothing changed.");
  let body: Record<string, unknown>;
  try {
    const res = await f("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: q.code,
        redirect_uri: pending.redirectUri,
        client_id: env.DROPBOX_APP_KEY,
        client_secret: env.DROPBOX_APP_SECRET,
      }).toString(),
    });
    if (res.status !== 200) return fail(`Dropbox refused the new key (HTTP ${res.status}), so nothing changed.`);
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail("Could not reach Dropbox, so nothing changed.");
  }
  const token = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!token) return fail("Dropbox sent no lasting key, so nothing changed.");
  const sealed = sealToken(token, env);
  if (!sealed) return fail("The new key could not be stored safely, so nothing changed.");
  putState(db, TOKEN_KEY, sealed);
  setStoredRefreshToken(token);
  clearDropboxCache();
  const scopes = typeof body.scope === "string"
    ? body.scope.split(/\s+/).filter((s) => /^[a-z_]+(\.[a-z_]+)+$/.test(s))
    : undefined;
  const missing = scopes && !scopes.includes("files.content.read");
  return record(db, {
    ok: true,
    at,
    detail: missing
      ? 'Dropbox reconnected, but the new key still cannot read files: tick "files.content.read" in the app\'s Permissions tab, press Submit, then reconnect again.'
      : "Dropbox reconnected; the backup check now uses the new key.",
    scopes,
  });
}
