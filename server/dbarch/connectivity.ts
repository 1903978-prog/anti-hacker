import { lookup } from "node:dns/promises";
import net from "node:net";
import { APPS } from "./apps.js";
import { ConnectError, parseTarget, type Connector } from "./connect.js";
import { verifyPermissions, type PermissionReport } from "./permissions.js";
import type { AppKey } from "./types.js";

export interface Stage { id: string; label: string; ok: boolean | null; detail: string }
export interface ConnectivityReport { app: AppKey; label: string; ok: boolean; stages: Stage[]; permissions: PermissionReport | null }

export interface NetOps {
  resolve(host: string): Promise<void>;
  tcp(host: string, port: number): Promise<void>;
}
export const realNet: NetOps = {
  resolve: async (h) => { await lookup(h); },
  tcp: (host, port) => new Promise((res, rej) => {
    const s = net.connect({ host, port, timeout: 6_000 });
    s.once("connect", () => { s.destroy(); res(); });
    s.once("timeout", () => { s.destroy(); rej(new Error("timeout")); });
    s.once("error", rej);
  }),
};

/**
 * One-click staged test from the secval server: configured? -> DNS -> TCP ->
 * TLS + login (read-only session) -> effective permissions. Messages are fixed
 * labels; the connection string, password and SQL errors are never shown.
 */
export async function testConnectivity(app: AppKey, env: NodeJS.ProcessEnv, connect: Connector, net_: NetOps = realNet, now: Date = new Date()): Promise<ConnectivityReport> {
  const cfg = APPS[app];
  const stages: Stage[] = [];
  const done = (ok: boolean, permissions: PermissionReport | null = null): ConnectivityReport => ({ app, label: cfg.label, ok, stages, permissions });
  const cs = env[cfg.envVar]?.trim();
  stages.push({ id: "configured", label: "Secret is set on this server", ok: !!cs, detail: cs ? "set" : `${cfg.envVar} is not set` });
  if (!cs) return done(false);
  let target: ReturnType<typeof parseTarget>;
  try {
    target = parseTarget(cs);
    stages.push({ id: "format", label: "Looks like a postgres URL", ok: true, detail: "ok" });
  } catch (e) {
    stages.push({ id: "format", label: "Looks like a postgres URL", ok: false, detail: e instanceof ConnectError ? e.message : "invalid" });
    return done(false);
  }
  const tlsOk = target.loopback || (!!target.sslmode && ["require", "verify-ca", "verify-full"].includes(target.sslmode));
  stages.push({ id: "tls_setting", label: "TLS is required in the connection string", ok: tlsOk, detail: tlsOk ? "sslmode set" : "add ?sslmode=require" });
  if (!tlsOk) return done(false);
  try { await net_.resolve(target.host); stages.push({ id: "dns", label: "Host name resolves", ok: true, detail: "ok" }); }
  catch { stages.push({ id: "dns", label: "Host name resolves", ok: false, detail: "lookup failed from this server" }); return done(false); }
  try { await net_.tcp(target.host, target.port); stages.push({ id: "tcp", label: "Network port reachable", ok: true, detail: "ok" }); }
  catch { stages.push({ id: "tcp", label: "Network port reachable", ok: false, detail: "no TCP connection from this server (firewall or wrong host)" }); return done(false); }
  let session;
  try { session = await connect(cs); stages.push({ id: "login", label: "TLS handshake and login (read-only session)", ok: true, detail: "ok" }); }
  catch (e) { stages.push({ id: "login", label: "TLS handshake and login (read-only session)", ok: false, detail: e instanceof ConnectError ? e.message : "login failed" }); return done(false); }
  try {
    const p = await verifyPermissions(session, now);
    stages.push({ id: "permissions", label: "Effective permissions are read-only", ok: p.leastPrivilege, detail: p.leastPrivilege ? "no write, DDL, ownership or admin privilege" : "the login has a privilege it must not have (see list)" });
    return done(p.leastPrivilege === true, p);
  } catch {
    stages.push({ id: "permissions", label: "Effective permissions are read-only", ok: null, detail: "could not be checked" });
    return done(false);
  } finally { await session.close(); }
}
