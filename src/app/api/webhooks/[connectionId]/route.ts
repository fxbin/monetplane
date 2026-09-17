import { NextResponse } from "next/server";
import { processProviderWebhook } from "@/modules/commerce/webhook";
import { publishBillingLifecycleEvent } from "@/server/control-plane/billing-events";

/**
 * Inbound provider webhook receiver.
 *
 * Authenticates via the provider adapter's signature verification (no
 * session/API key — providers call this directly). After the durable
 * commerce effect commits, committed lifecycle changes fan out to
 * developer webhook endpoints (#61).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  try {
    const applicationId = headers["x-monetplane-application"];
    if (typeof applicationId !== "string" || !applicationId) {
      return NextResponse.json(
        { error: "x-monetplane-application header is required" },
        { status: 400 },
      );
    }

    const result = await processProviderWebhook(applicationId, connectionId, {
      rawBody,
      headers,
    });

    // Fan out developer events only for newly processed, committed
    // lifecycle transitions; duplicates replays are skipped (idempotent
    // event identity additionally guards at delivery level).
    if (!result.duplicate && result.status === "processed") {
      await publishBillingLifecycleEvent({
        applicationId,
        webhookEventId: result.webhookEventId,
        providerConnectionId: connectionId,
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "InvalidProviderWebhookSignatureError") {
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 },
      );
    }
    if (name === "ProviderAdapterNotRegisteredError") {
      return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Failed to process webhook" },
      { status: 500 },
    );
  }
}
