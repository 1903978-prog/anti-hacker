/**
 * Post-deploy verification: waits until production reports the released
 * commit and a healthy store. Never reads or prints secrets; only the
 * public /health and /health/store answers are used.
 */
export interface Http { status: number; json(): Promise<unknown> }
export type Getter = (url: string) => Promise<Http>;

export interface VerifyDeps {
  get: Getter;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
export interface VerifyResult { ok: boolean; liveCommit: string | null; reasons: string[]; checks: number }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function verifyDeploy(baseUrl: string, sha: string, opts: { timeoutMs: number; pollMs: number }, d: VerifyDeps): Promise<VerifyResult> {
  const want = sha.slice(0, 12);
  const end = d.now() + opts.timeoutMs;
  let live: string | null = null;
  let checks = 0;
  let last = "no answer yet";
  while (d.now() <= end) {
    checks++;
    try {
      const r = await d.get(`${baseUrl}/health`);
      if (r.status === 200) {
        const h = obj(await r.json());
        live = (obj(h.measurement).commit as string | null) ?? null;
        if (live === want) {
          const reasons: string[] = [];
          if (h.ok !== true) reasons.push("/health ok is not true");
          if (obj(h.store).ok !== true) reasons.push("store integrity check is not ok");
          const s = await d.get(`${baseUrl}/health/store`);
          if (s.status !== 200) reasons.push(`/health/store answered ${s.status}`);
          return { ok: reasons.length === 0, liveCommit: live, reasons: reasons.length ? reasons : ["live commit matches and health checks pass"], checks };
        }
        last = `live commit is ${live ?? "unknown"}, waiting for ${want}`;
      } else last = `/health answered ${r.status}`;
    } catch {
      last = "production unreachable";
    }
    await d.sleep(opts.pollMs);
  }
  return { ok: false, liveCommit: live, reasons: [`not live within ${Math.round(opts.timeoutMs / 60000)} min: ${last}`], checks };
}
