/**
 * Edge-safe bounded sliding-window rate limiter.
 *
 * Prunes expired entries before allocating a new key and fails closed when the
 * window map reaches `maxWindows`, preventing memory exhaustion under key-churn
 * floods.
 */

export type RateLimitWindow = {
  count: number;
  resetAt: number;
};

export const DEFAULT_RATE_LIMIT_MAX_WINDOWS = 10_000;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

export function extractRateLimitClientBucket(
  request: Request,
  trustProxy: boolean,
): string {
  if (!trustProxy) {
    return "shared";
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "shared";
}

export function consumeBoundedRateLimit(
  windows: Map<string, RateLimitWindow>,
  key: string,
  limit: number,
  options: {
    now?: number;
    windowMs?: number;
    maxWindows?: number;
  } = {},
): boolean {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxWindows = options.maxWindows ?? DEFAULT_RATE_LIMIT_MAX_WINDOWS;

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    for (const [k, state] of windows) {
      if (state.resetAt <= now) windows.delete(k);
    }
    if (windows.size >= maxWindows) {
      return false;
    }
    windows.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return true;
  }

  existing.count += 1;
  return existing.count <= limit;
}
