import { NextResponse } from "next/server";
import {
  InvalidNormalizedCommerceEventError,
  processProviderWebhook,
} from "@/modules/commerce/webhook";
import { getProviderConnectionApplicationId } from "@/modules/providers/service";
import { publishBillingLifecycleEvent } from "@/server/control-plane/billing-events";

/**
 * Inbound provider webhook receiver.
 *
 * Authenticates via the provider adapter's signature verification (no
 * session/API key — providers call this directly). After the durable
 * commerce effect commits, committed lifecycle changes fan out to
 * developer webhook endpoints (#61).
 *
 * Response policy (replaces the blanket 200 of #97):
 * - signature failure -> 401 (provider/scanner sees the rejection)
 * - unknown/revoked/inactive connection or unregistered provider -> 404
 *   (permanent: no redelivery can fix it)
 * - permanent validation failure (event data inconsistent with recorded
 *   state) -> 422 processed:false; the event is durably recorded as
 *   `failed` in the inbox for inspection and no provider retry can fix it
 * - anything else -> 503 processed:false; the event is durably recorded as
 *   `failed` and the provider's redelivery IS the retry path — replay hits
 *   the inbox row, `failed` rows are reprocessable, and event-id idempotency
 *   plus the deliveries' unique (endpoint, eventId) index keep replays from
 *   double-applying anything.
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
    // payload.
    const applicationId =
      await getProviderConnectionApplicationId(connectionId);
    if (!applicationId) {
      return NextResponse.json(
        { error: "Unknown webhook connection" },
        { status: 404 },
      );
    }

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
      if (error instanceof InvalidNormalizedCommerceEventError) {
        // Permanent, deterministic failure (e.g. currency mismatch). Most of
        // these park the event as `failed` in the inbox; a few validation
        // throw sites run before the inbox insert. Either way retrying cannot
        // succeed, so answer 422 and let the inbox drive manual inspection.
        return NextResponse.json(
          {
            received: true,
            processed: false,
            permanent: true,
            error: error.message,
          },
          { status: 422 },
        );
      }
      if (name === "ProviderAdapterNotRegisteredError") {
        // Unknown/unregistered provider — not a transient failure; the outer
        // catch answers 404 so the operator fixes the deployment instead of
        // the provider retrying.
        throw error;
      }
      if (name === "ProviderConnectionNotFoundError") {
        // The connection exists (checked above) but is revoked/inactive —
        // commerce only processes events for active connections. Retrying
        // can never succeed, so answer 404 instead of 503 to stop the
        // provider's redelivery loop (project review 2026-10-04, 1.7).
        return NextResponse.json(
          { error: "Webhook connection is not active" },
          { status: 404 },
        );
      }
      // Transient failure (DB contention, deadlock abort, ...): the event is
      // recorded as failed and reprocessable — a 503 asks the provider to
      // redeliver, which is the automatic retry path.
      return NextResponse.json(
        { received: true, processed: false },
        { status: 503 },
      );
    }

    // Fan out developer events for committed lifecycle transitions.
    // Attempted for duplicate replays too: if the first attempt crashed
    // between the commerce commit and this publish, the provider's redelivery
    // lands here and heals the missed fan-out. Deterministic event identity +
    // the deliveries' unique (endpoint, eventId) index make this a no-op when
    // the first attempt already published.
    if (result.status === "processed") {
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
