import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { orders, webhookEvents } from "@/modules/commerce/schema";
import { applicationCustomers } from "@/modules/customers/schema";
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

  // MP-REV-04: the developer contract's externalCustomerId is the
  // APPLICATION's customer identifier (application_customers
  // .external_customer_id) — never the PSP's customer id. Resolve it from
  // the verified internal customer id, falling back to the order's customer
  // when the event does not carry one.
  const monetplaneCustomerId =
    typeof normalized.monetplaneCustomerId === "string"
      ? normalized.monetplaneCustomerId
      : null;
  let externalCustomerId: string | null = null;
  if (monetplaneCustomerId) {
    const [customer] = await db
      .select({
        externalCustomerId: applicationCustomers.externalCustomerId,
      })
      .from(applicationCustomers)
      .where(
        and(
          eq(applicationCustomers.applicationId, input.applicationId),
          eq(applicationCustomers.id, monetplaneCustomerId),
        ),
      )
      .limit(1);
    externalCustomerId = customer?.externalCustomerId ?? null;
  }
  if (!externalCustomerId && normalized.monetplaneOrderId) {
    const [orderCustomer] = await db
      .select({
        externalCustomerId: applicationCustomers.externalCustomerId,
      })
      .from(applicationCustomers)
      .innerJoin(
        orders,
        eq(orders.applicationCustomerId, applicationCustomers.id),
      )
      .where(
        and(
          eq(orders.applicationId, input.applicationId),
          eq(orders.id, String(normalized.monetplaneOrderId)),
        ),
      )
      .limit(1);
    externalCustomerId = orderCustomer?.externalCustomerId ?? null;
  }

  const context: BillingEventContext = {
    orderId:
      typeof normalized.monetplaneOrderId === "string"
        ? normalized.monetplaneOrderId
        : null,
    externalCustomerId,
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
