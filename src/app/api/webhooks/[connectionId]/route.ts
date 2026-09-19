import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { processProviderWebhook } from "@/modules/commerce/webhook";
import { providerConnections } from "@/modules/providers/schema";
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
    // The URL's connection id IS the routing credential: resolve the
    // application from the connection itself. Real providers never send
    // custom routing headers; signature verification authenticates the
    // payload. (The x-monetplane-application header remains an optional
    // test-only override.)
    const [connection] = await getDb()
      .select({ applicationId: providerConnections.applicationId })
      .from(providerConnections)
      .where(eq(providerConnections.id, connectionId))
      .limit(1);
    if (!connection) {
      return NextResponse.json(
        { error: "Unknown webhook connection" },
        { status: 404 },
      );
    }
    const headerApplication = headers["x-monetplane-application"];
    const applicationId =
      typeof headerApplication === "string" && headerApplication
        ? headerApplication
        : connection.applicationId;

    let result: Awaited<ReturnType<typeof processProviderWebhook>>;
    try {
      result = await processProviderWebhook(applicationId, connectionId, {
        rawBody,
        headers,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "InvalidProviderWebhookSignatureError") {
        // Authentication failure — keep 401 so providers and scanners see it.
        return NextResponse.json(
          { error: "Invalid webhook signature" },
          { status: 401 },
        );
      }
      // Signature already verified: the event is durably recorded with its
      // failure by the inbox. Return 200 processed:false so the provider
      // stops its retry schedule instead of looping for 24h (#97).
      return NextResponse.json({
        received: true,
        processed: false,
        error: error instanceof Error ? error.message : "Processing failed",
      });
    }

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
