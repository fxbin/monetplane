import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { expireDueCreditBuckets } from "@/modules/credits/buckets";

/**
 * Protected cron endpoint: expires due credit buckets (B3).
 *
 * `expireDueCreditBuckets` is the only writer that transitions expired
 * buckets out of `active`; without it expired credits remain spendable and
 * the documented invariant (sum of active bucket remaining ==
 * available + reserved) drifts. Scheduling is documented in
 * docs/credits-ledger.md ("Credit bucket expiry").
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`, compared with
 * timingSafeEqual. Fails closed — when CRON_SECRET is unset or mismatched
 * the endpoint returns 401 and expiry never runs.
 */
export const runtime = "nodejs";

async function runCreditExpiry(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const expired = await expireDueCreditBuckets();
    return NextResponse.json({
      expiredBuckets: expired.length,
      expiredAmountMinor: expired.reduce(
        (sum, entry) => sum + entry.reversedAmount,
        0,
      ),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Credit bucket expiry failed",
      },
      { status: 500 },
    );
  }
}

// GET so Vercel Cron / generic schedulers work unconfigured; POST for
// schedulers that default to POST (both require the same secret).
export async function GET(request: Request) {
  return runCreditExpiry(request);
}

export async function POST(request: Request) {
  return runCreditExpiry(request);
}
