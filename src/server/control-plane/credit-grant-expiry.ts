import { NextResponse } from "next/server";

/**
 * Parses the admin credit-grant expiry input (roundtable 2026-10-06,
 * PR4). Accepts either an ISO 8601 `expiresAt` or a whole number of days
 * via `expiresInDays`; invalid shapes answer 400 instead of silently
 * granting non-expiring credits (verifier finding).
 */
export function parseGrantExpiry(body: Record<string, unknown>): {
  expiresAt: Date | null;
  error: NextResponse | null;
} {
  if (typeof body.expiresAt === "string" && body.expiresAt.trim()) {
    const parsed = new Date(body.expiresAt.trim());
    if (Number.isNaN(parsed.getTime())) {
      return {
        expiresAt: null,
        error: NextResponse.json(
          { error: "expiresAt must be a valid ISO 8601 timestamp" },
          { status: 400 },
        ),
      };
    }
    return { expiresAt: parsed, error: null };
  }
  if (body.expiresInDays !== undefined) {
    if (
      typeof body.expiresInDays !== "number" ||
      !Number.isSafeInteger(body.expiresInDays) ||
      body.expiresInDays <= 0
    ) {
      return {
        expiresAt: null,
        error: NextResponse.json(
          { error: "expiresInDays must be a positive whole number of days" },
          { status: 400 },
        ),
      };
    }
    return {
      expiresAt: new Date(Date.now() + body.expiresInDays * 24 * 3600 * 1000),
      error: null,
    };
  }
  return { expiresAt: null, error: null };
}
