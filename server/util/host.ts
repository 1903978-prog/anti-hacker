/**
 * Normalizes user input into a bare lowercase hostname (no scheme, port, path,
 * or trailing dot). Accepts either a full URL or a bare domain. Returns null
 * when the input cannot be understood as a host — callers treat null as "not
 * allowed", keeping the fail-closed posture.
 */
export function toHostname(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // No scheme — treat as a bare host (optionally with a path we discard).
    candidate = "https://" + candidate;
  }

  let host: string;
  try {
    host = new URL(candidate).hostname;
  } catch {
    return null;
  }

  host = host.toLowerCase().replace(/\.$/, "");
  if (host === "") return null;

  // Basic shape check: letters/digits/hyphens in dot-separated labels.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return null;
  }
  return host;
}
