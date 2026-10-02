/**
 * Transitional host-only read guards (#127).
 *
 * Policy (decided 2026-10): balances/entitlements are application-private
 * data; the credential is the preferred auth for SDK read endpoints. The
 * Host-header fallback stays available for branded-host read surfaces during
 * a migration window, but host-only reads are rate limited per application
 * and client, and limit breaches raise an anomaly signal.
 *
 * Scope notes (deliberate):
 * - in-memory fixed window ⇒ per-instance; sufficient for a transitional
 *   control on a single-process deployment (the reference architecture is
 *   a modular monolith). A shared store becomes necessary only if the
 *   deployment fans out — recorded as the reopen condition in the
 *   credential-gate decision note.
 * - credential-authenticated reads are NOT limited here (trusted callers);
 *   abuse of credentials is a credential-revocation concern.
 */

type WindowState = { count: number; resetAt: number };

const windows = new Map<string, WindowState>();
const WINDOW_MS = 60_000;

export function hostReadLimitPerMinute(): number {
  const parsed = Number(process.env.MONETPLANE_HOST_READ_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Consume one unit of the host-only read quota for (application, client).
 * Returns whether the read may proceed.
 */
export function consumeHostReadQuota(
  applicationId: string,
  request: Request,
): { allowed: boolean; limit: number } {
  const limit = hostReadLimitPerMinute();
  const key = `${applicationId}:${clientIp(request)}`;
  const now = Date.now();

  const state = windows.get(key);
  if (!state || state.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, limit };
  }
  if (state.count >= limit) {
    return { allowed: false, limit };
  }
  state.count += 1;

  // Opportunistic pruning keeps the map bounded under key churn.
  if (windows.size > 10_000) {
    for (const [k, v] of windows) {
      if (v.resetAt <= now) windows.delete(k);
    }
  }
  return { allowed: true, limit };
}

/** Test hook: reset the in-memory windows between integration tests. */
export function resetHostReadQuotaForTests(): void {
  windows.clear();
}
