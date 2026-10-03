/**
 * Transitional host-only read guards (#127).
 *
 * Policy (decided 2026-10): balances/entitlements are application-private
 * data; the credential is the preferred auth for SDK read endpoints. The
 * Host-header fallback stays available for branded-host read surfaces during
 * a migration window, but host-only reads are rate limited per application
 * and client, and the first breach per window raises an anomaly signal.
 *
 * Deployment contract (round-2 review):
 * - `MONETPLANE_TRUST_PROXY=true` ONLY when deployed behind a reverse proxy
 *   that OVERWRITES `x-forwarded-for` (Vercel and standard proxies do).
 *   Without it the header is client-controlled and per-IP buckets would be
 *   free to mint — every client then shares ONE bucket per application.
 * - The window map is hard-capped (`MONETPLANE_HOST_READ_MAX_WINDOWS`,
 *   default 10k). Pruning runs before any new bucket is created; if the map
 *   is still full afterwards the limiter fails CLOSED (new keys are denied,
 *   memory cannot grow) — a key-flood attack degrades to shared-scarcity,
 *   never to OOM.
 * - Credential-authenticated reads never reach this limiter.
 * - In-memory window = per-instance (modular-monolith deployment); a shared
 *   store is the documented reopen condition (credential-gate decision note).
 */

type WindowState = { count: number; resetAt: number; breachLogged: boolean };

const windows = new Map<string, WindowState>();
const WINDOW_MS = 60_000;

export function hostReadLimitPerMinute(): number {
  const parsed = Number(process.env.MONETPLANE_HOST_READ_LIMIT);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 60;
}

export function hostReadMaxWindows(): number {
  const parsed = Number(process.env.MONETPLANE_HOST_READ_MAX_WINDOWS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 10_000;
}

function trustProxyHeaders(): boolean {
  return process.env.MONETPLANE_TRUST_PROXY === "true";
}

function clientBucket(request: Request): string {
  if (!trustProxyHeaders()) {
    // Untrusted x-forwarded-for: rotating it must not mint new buckets.
    // All host-only clients share one bucket per application.
    return "shared";
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "shared";
}

function pruneExpiredWindows(now: number): void {
  for (const [key, state] of windows) {
    if (state.resetAt <= now) windows.delete(key);
  }
}

/**
 * Consume one unit of the host-only read quota for (application, client).
 * `anomaly` is true only on the FIRST breach of a window — a flooding
 * attacker must not also flood the logs.
 */
export function consumeHostReadQuota(
  applicationId: string,
  request: Request,
): { allowed: boolean; limit: number; anomaly: boolean } {
  const limit = hostReadLimitPerMinute();
  const now = Date.now();
  const key = `${applicationId}:${clientBucket(request)}`;

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    // Prune BEFORE creating a bucket so key churn always triggers cleanup,
    // then hard-cap: fail closed instead of growing the map.
    pruneExpiredWindows(now);
    if (windows.size >= hostReadMaxWindows()) {
      return { allowed: false, limit, anomaly: false };
    }
    windows.set(key, {
      count: 1,
      resetAt: now + WINDOW_MS,
      breachLogged: false,
    });
    return { allowed: true, limit, anomaly: false };
  }

  if (existing.count >= limit) {
    if (!existing.breachLogged) {
      existing.breachLogged = true;
      return { allowed: false, limit, anomaly: true };
    }
    return { allowed: false, limit, anomaly: false };
  }
  existing.count += 1;
  return { allowed: true, limit, anomaly: false };
}

/** Test hook: reset the in-memory windows between integration tests. */
export function resetHostReadQuotaForTests(): void {
  windows.clear();
}
