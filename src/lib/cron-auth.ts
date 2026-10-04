import { timingSafeEqual } from "node:crypto";
import { getCronSecret } from "../config/env";

/**
 * Bearer authentication for /api/cron/* endpoints (roundtable batch 3):
 * the two cron routes used to carry identical copies of this check. Fails
 * closed — an unset CRON_SECRET authorizes nothing, and the comparison is
 * length-guarded + timing-safe.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const expected = getCronSecret();
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(
    header.slice(prefix.length).trim(),
    "utf8",
  );
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
