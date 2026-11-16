import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Signed attestation for SecVal's own Dropbox copies.
 *
 * A copy counts towards "2 validated copies" only when, at CHECK time (the daily Dropbox check, not just
 * when the copy was made):
 *   1. its manifest is present next to it and carries a valid HMAC-SHA256 signature made with a key derived
 *      from SECVAL_BACKUP_KEY (no key on the checking server = nothing verifiable = not counted);
 *   2. the signed manifest names exactly that file (path, app, kind);
 *   3. the bytes Dropbox holds NOW match what was signed: size and Dropbox's own content_hash (from the
 *      folder listing) equal the signed `bytes` and `dropboxContentHash`.
 * The restore itself (download, decrypt, open the database / check the code zip) is proven once, when the
 * copy is made, and recorded inside the signed manifest (`restoreCheck`). The daily check proves the bytes
 * that were restored are still the bytes stored. It does not re-run the restore.
 */

const MANIFEST_SIG_INFO = "manifest-sign-v1";

/** HMAC key for manifests, separate from the encryption key (different HKDF info). Null without the key. */
export function attestationKey(env: Record<string, string | undefined>): Buffer | null {
  const own = env.SECVAL_BACKUP_KEY;
  if (!own || own.length < 32) return null;
  return Buffer.from(hkdfSync("sha256", own, "secval-second-copy", MANIFEST_SIG_INFO, 32));
}

/** JSON with keys sorted at every level, so the signature does not depend on key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function signManifest<T extends Record<string, unknown>>(m: T, key: Buffer): T & { signature: string } {
  const { signature: _drop, ...body } = m as T & { signature?: unknown };
  return { ...(body as T), signature: createHmac("sha256", key).update(canonical(body)).digest("hex") };
}

export function manifestSignatureValid(m: Record<string, unknown>, key: Buffer): boolean {
  const sig = m.signature;
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const { signature: _s, ...body } = m;
  const want = createHmac("sha256", key).update(canonical(body)).digest();
  return timingSafeEqual(want, Buffer.from(sig, "hex"));
}

/** Dropbox's content_hash: SHA-256 of the concatenated SHA-256 digests of each 4 MiB block. */
export function dropboxContentHash(buf: Buffer): string {
  const BLOCK = 4 * 1024 * 1024;
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += BLOCK) parts.push(createHash("sha256").update(buf.subarray(i, i + BLOCK)).digest());
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

export interface ListedCopy {
  name: string;
  path?: string;
  size?: number;
  contentHash?: string;
}

/** Checks one SecVal copy against its downloaded manifest (parsed JSON or text). Returns null when verified, else the reason. */
export function verifyCopy(entry: ListedCopy, manifest: unknown, key: Buffer | null): string | null {
  if (!key) return "SECVAL_BACKUP_KEY is not available to the checker, so its signed manifest cannot be verified";
  if (manifest === null || manifest === undefined) return "its manifest is missing";
  let m = manifest as Record<string, unknown>;
  if (typeof manifest === "string") {
    try {
      m = JSON.parse(manifest);
    } catch {
      return "its manifest is not valid JSON";
    }
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return "its manifest is not valid JSON";
  if (!manifestSignatureValid(m, key)) return "its manifest signature is invalid (tampered, or made with another key)";
  const kind = /-secval-(db|code)\./.exec(entry.name)?.[1];
  if (m.app !== "secval" || m.kind !== kind) return "its manifest describes a different copy";
  if (typeof m.file !== "string" || !entry.path || m.file.toLowerCase() !== entry.path.toLowerCase())
    return "its manifest names a different file";
  if (typeof m.dropboxContentHash !== "string" || typeof m.bytes !== "number") return "its manifest has no stored-bytes fingerprint";
  if (entry.size !== m.bytes) return "the stored file's size differs from the signed manifest";
  if (!entry.contentHash || entry.contentHash !== m.dropboxContentHash) return "the stored file's bytes differ from the signed manifest";
  return null;
}
