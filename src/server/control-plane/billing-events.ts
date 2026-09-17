import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { webhookEvents } from "@/modules/commerce/schema";
import { dispatchWebhookEvent } from "@/modules/webhooks/service";

/**
 * Billing lifecycle event publisher (#61).
 *
 * Application/runtime orchestration boundary: turns committed provider
 * webhook effects into provider-neutral developer events and fans them out
 * to configured developer webhook endpoints through the existing delivery
 * infrastructure (filtering, signing, persistence, retry).
 *
 * Contract:
 * - Called only AFTER the durable MonetPlane state transition committed
 *   (processProviderWebhook returned with duplicate=false).
 * - Event identity is deterministic (derived from the stored webhook event
 *   id + logical type), so replayed provider events cannot create
 *   duplicate logical developer events; deliveries are additionally unique
 *   per (endpoint, eventId).
 * - Payloads are provider-neutral: no raw provider bodies, no secrets.
 * - Envelope carries a forward-compatible version field (currently 1).
 */

export const DEVELOPER_EVENT_VERSION = 1;

/** Provider event type -> provider-neutral developer event type. */
const EVENT_TYPE_MAP: Record<string, string> = {
  "payment.succeeded": "payment.succeeded",
  "payment.failed": "payment.failed",
  "payment.refunded": "payment.refunded",
  "subscription.activated": "subscription.activated",
  "subscription.renewed": "subscription.renewed",
  "subscription.recovered": "subscription.recovered",
  "subscription.cancelled": "subscription.cancelled",
  "subscription.expired": "subscription.expired",
};

export type BillingEventContext = {
  orderId?: string | null;
  paymentId?: string | null;
  subscriptionId?: string | null;
  externalCustomerId?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
};

export async function publishBillingLifecycleEvent(
  input: {
    applicationId: string;
    webhookEventId: string;
    providerConnectionId: string;
    fetchImpl?: typeof fetch;
  },
  db: Database = getDb(),
) {
  const [event] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, input.webhookEventId))
    .limit(1);
  if (!event) {
    throw new Error("Webhook event not found for developer fan-out");
  }

  const normalized = event.normalizedEvent as Record<string, unknown>;
  const developerType = EVENT_TYPE_MAP[event.normalizedType] ?? null;
  if (!developerType) {
    // Unknown/low-value provider events are not part of the public
    // developer contract.
    return { published: false, eventType: event.normalizedType, eventId: null };
  }

  const context: BillingEventContext = {
    orderId:
      typeof normalized.monetplaneOrderId === "string"
        ? normalized.monetplaneOrderId
        : null,
    externalCustomerId:
      typeof normalized.providerCustomerId === "string"
        ? normalized.providerCustomerId
        : null,
    amountMinor:
      typeof normalized.amountMinor === "number"
        ? normalized.amountMinor
        : null,
    currency:
      typeof normalized.currency === "string" ? normalized.currency : null,
  };

  const result = await dispatchWebhookEvent(
    {
      applicationId: input.applicationId,
      mode: event.environment as "test" | "live",
      eventId: `dev_${event.id}`,
      eventType: developerType,
      providerConnectionId: input.providerConnectionId,
      externalCustomerId: context.externalCustomerId,
      orderId: context.orderId,
      data: {
        version: DEVELOPER_EVENT_VERSION,
        environment: event.environment,
        occurredAt: event.occurredAt.toISOString(),
        orderId: context.orderId,
        externalCustomerId: context.externalCustomerId,
        amountMinor: context.amountMinor,
        currency: context.currency,
      },
    },
    input.fetchImpl ? { fetchImpl: input.fetchImpl } : {},
    db,
  );

  return { published: true, eventType: developerType, eventId: result.eventId };
}
