import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import {
  orders,
  payments,
  subscriptions,
  webhookEvents,
} from "@/modules/commerce/schema";
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
          // normalized.monetplaneCustomerId carries the global customers.id
          // (cus_...), NOT the applicationCustomers row id (acus_...) —
          // match on the customerId column (verifier finding).
          eq(applicationCustomers.customerId, monetplaneCustomerId),
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
  // §二A: some PSP events carry neither internal reference — resolve from
  // the recorded payment (provider payment id) or subscription when the
  // database already knows the relationship.
  if (!externalCustomerId && normalized.providerPaymentId) {
    const [paymentCustomer] = await db
      .select({
        externalCustomerId: applicationCustomers.externalCustomerId,
      })
      .from(payments)
      .innerJoin(
        applicationCustomers,
        // payments.customerId stores the global customers.id (cus_...);
        // applicationCustomers.id is the acus_... row id — match on the
        // customerId column (same id-space trap as the primary lookup).
        eq(applicationCustomers.customerId, payments.customerId),
      )
      .where(
        and(
          eq(payments.applicationId, input.applicationId),
          eq(payments.providerConnectionId, input.providerConnectionId),
          eq(payments.providerPaymentId, String(normalized.providerPaymentId)),
          // Round-3 finding: the global customerId can be linked to
          // application customers in MULTIPLE applications — constrain the
          // join target to this application or another app's
          // externalCustomerId may leak into the event.
          eq(applicationCustomers.applicationId, input.applicationId),
        ),
      )
      .limit(1);
    externalCustomerId = paymentCustomer?.externalCustomerId ?? null;
  }
  if (!externalCustomerId && normalized.providerSubscriptionId) {
    const [subscriptionCustomer] = await db
      .select({
        externalCustomerId: applicationCustomers.externalCustomerId,
      })
      .from(subscriptions)
      .innerJoin(
        applicationCustomers,
        eq(applicationCustomers.id, subscriptions.applicationCustomerId),
      )
      .where(
        and(
          eq(subscriptions.applicationId, input.applicationId),
          eq(subscriptions.providerConnectionId, input.providerConnectionId),
          eq(
            subscriptions.providerSubscriptionId,
            String(normalized.providerSubscriptionId),
          ),
        ),
      )
      .limit(1);
    externalCustomerId = subscriptionCustomer?.externalCustomerId ?? null;
  }
  // Cross-validate: when the event carries BOTH a customer reference and an
  // order reference, they must belong to the same application customer — a
  // mismatch is provider metadata corruption and resolves to null rather
  // than silently preferring one side.
  if (
    externalCustomerId &&
    normalized.monetplaneCustomerId &&
    normalized.monetplaneOrderId
  ) {
    const [mismatch] = await db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(
        applicationCustomers,
        eq(applicationCustomers.id, orders.applicationCustomerId),
      )
      .where(
        and(
          eq(orders.applicationId, input.applicationId),
          eq(orders.id, String(normalized.monetplaneOrderId)),
          eq(
            applicationCustomers.customerId,
            String(normalized.monetplaneCustomerId),
          ),
        ),
      )
      .limit(1);
    if (!mismatch) {
      console.error(
        `[monetplane] developer event customer/order metadata mismatch for order ${String(normalized.monetplaneOrderId)}; dropping externalCustomerId`,
      );
      externalCustomerId = null;
    }
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
