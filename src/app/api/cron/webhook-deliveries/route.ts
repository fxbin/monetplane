import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { sweepPendingWebhookDeliveries } from "@/modules/webhooks/service";

/**
 * Protected cron endpoint: sweeps stale pending developer-webhook
 * deliveries (#126).
 *
 * Closes the crash window between a delivery row's INSERT and its attempt:
 * dispatch delivers only newly-inserted rows, so a process dying mid-flight
 * leaves `pending` rows that provider replays conflict-skip and the
 * operator retry (failed-only) refuses. The sweeper re-delivers stale rows
 * under an exponential backoff with an atomic claim (concurrent sweeps
 * never double-deliver) and parks rows exceeding the max attempts.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timingSafeEqual, fails
 * closed). Schedule every 1-5 minutes alongside /api/cron/credit-expiry.
 */
export const runtime = "nodejs";

async function runSweep(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sweepPendingWebhookDeliveries();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[cron/webhook-deliveries] Error:", error);
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return runSweep(request);
}

export async function POST(request: Request) {
  return runSweep(request);
}
