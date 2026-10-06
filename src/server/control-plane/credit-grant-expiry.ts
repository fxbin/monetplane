import { NextResponse } from "next/server";

/**
 * Parses the admin credit-grant expiry input (roundtable 2026-10-06,
 * PR4; hardened by external review P1-150-04).
 *
 * Contract (server is the single source of truth):
 *  - field ABSENT → no expiry (null)
 *  - `expiresAt` present → must be a non-empty ISO 8601 string that
 *    parses to a real date, anything else is a 400
 *  - `expiresInDays` present → must be a positive whole number
 *  - both fields present → 400 (no implicit precedence)
 */
export function parseGrantExpiry(body: Record<string, unknown>): {
  expiresAt: Date | null;
  error: NextResponse | null;
} {
  const hasExpiresAt = Object.hasOwn(body, "expiresAt");
  const hasDays = Object.hasOwn(body, "expiresInDays");
  if (hasExpiresAt && hasDays) {
    return {
      expiresAt: null,
      error: NextResponse.json(
        {
          error: "Provide either expiresAt or expiresInDays, not both",
        },
        { status: 400 },
      ),
    };
  }
  if (hasExpiresAt) {
    const value = body.expiresAt;
    if (typeof value !== "string" || !value.trim()) {
      return {
        expiresAt: null,
        error: NextResponse.json(
          { error: "expiresAt must be a non-empty ISO 8601 timestamp" },
          { status: 400 },
        ),
      };
    }
    const parsed = new Date(value.trim());
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
  if (hasDays) {
    const value = body.expiresInDays;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      return {
        expiresAt: null,
        error: NextResponse.json(
          {
            error: "expiresInDays must be a positive whole number of days",
          },
          { status: 400 },
        ),
      };
    }
    return {
      expiresAt: new Date(Date.now() + value * 24 * 3600 * 1000),
      error: null,
    };
  }
  return { expiresAt: null, error: null };
}
