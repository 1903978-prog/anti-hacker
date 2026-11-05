import type { NeonSettings } from "./types.js";

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Reads (GET only) branch and history-retention settings from the Neon API.
 * Returns null when no API token is configured or Neon is unreachable: the
 * caller then marks those checks N/V instead of guessing. Never changes
 * branch protection or any other setting.
 */
export async function readNeonSettings(
  projectId: string,
  token: string | undefined,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<NeonSettings | null> {
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const base = `https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}`;
  try {
    const signal = AbortSignal.timeout(10_000);
    const [pr, br] = await Promise.all([fetchFn(base, { headers, signal }), fetchFn(`${base}/branches`, { headers, signal })]);
    if (!pr.ok || !br.ok) return null;
    const project = ((await pr.json()) as { project?: { history_retention_seconds?: number } }).project ?? {};
    const branches = ((await br.json()) as { branches?: Array<{ id: string; name: string; default?: boolean; primary?: boolean; protected?: boolean }> }).branches ?? [];
    // Production branch = the one Neon flags as default (primary on older API versions).
    const prod = branches.find((b) => b.default === true) ?? branches.find((b) => b.primary === true) ?? null;
    return {
      branchName: prod?.name ?? null,
      branchId: prod?.id ?? null,
      protected: prod ? Boolean(prod.protected) : null,
      historyRetentionSeconds: typeof project.history_retention_seconds === "number" ? project.history_retention_seconds : null,
    };
  } catch {
    return null;
  }
}
