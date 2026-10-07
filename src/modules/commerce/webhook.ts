import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { applicationCustomers } from "../customers/schema";
import type { NormalizedProviderEvent } from "../providers/contract";
import { verifyAndNormalizeProviderWebhook } from "../providers/runtime";
import { getProviderConnection } from "../providers/service";
import { orders, webhookEvents } from "./schema";
import { applyPaymentEvent } from "./webhook-payment-events";
import {
  InvalidNormalizedCommerceEventError,
  parseEventDate,
  type WebhookProcessingContext,
} from "./webhook-shared";
import { applySubscriptionEvent } from "./webhook-subscription-events";

export { InvalidNormalizedCommerceEventError } from "./webhook-shared";

function eventErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown webhook error";
  return message.slice(0, 1000);
}

function asStoredNormalizedEvent(
  value: Record<string, unknown>,
): NormalizedProviderEvent {
  return value as unknown as NormalizedProviderEvent;
}

/**
 * Inbound provider webhook processing: durable inbox + exactly-once apply.
 *
 * Pipeline (roundtable batch 2 split — behavior identical to the former
 * single function, extraction is verbatim):
 *  1. verify + normalize via the provider adapter (outside the tx);
 *  2. insert into the webhook inbox (event-id unique per connection) and
 *     resolve the durable row id — replays converge on the same row;
 *  3. in one transaction: lock the inbox row, short-circuit processed/
 *     ignored replays, ignore unknown events, resolve order/customer
 *     context, then dispatch to the payment-family and subscription-family
 *     handlers (webhook-payment-events.ts / webhook-subscription-events.ts);
 *  4. mark the row processed. Any throw marks it failed and rethrows —
 *     failed rows are reprocessable via provider redelivery.
 */
export async function processProviderWebhook(
  applicationId: string,
  providerConnectionId: string,
  input: {
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
  },
  db: Database = getDb(),
) {
  const normalized = await verifyAndNormalizeProviderWebhook(
    applicationId,
    providerConnectionId,
    input,
    db,
  );

  if (
    normalized.applicationId !== applicationId ||
    normalized.providerConnectionId !== providerConnectionId
  ) {
    throw new InvalidNormalizedCommerceEventError(
      "Normalized provider event context mismatch",
    );
  }

  // Environment is derived from the receiving provider connection — never
  // from caller input (ADR: fail-closed environment selection).
  const providerConnection = await getProviderConnection(
    applicationId,
    providerConnectionId,
    db,
  );
  if (!providerConnection) {
    throw new Error("Active provider connection not found");
  }
  const environment = providerConnection.mode;

  const occurredAt = parseEventDate(normalized.occurredAt);
  if (!occurredAt) {
    throw new InvalidNormalizedCommerceEventError(
      "Provider event occurrence time is required",
    );
  }

  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      id: `wh_${randomUUID()}`,
      applicationId,
      providerConnectionId,
      providerEventId: normalized.providerEventId,
      providerEventName: normalized.providerEventName,
      normalizedType: normalized.type,
      rawBody: input.rawBody,
      normalizedEvent: normalized as unknown as Record<string, unknown>,
      environment,
      occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  const webhookEventId =
    inserted?.id ??
    (
      await db
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.providerConnectionId, providerConnectionId),
            eq(webhookEvents.providerEventId, normalized.providerEventId),
          ),
        )
        .limit(1)
    )[0]?.id;

  if (!webhookEventId) {
    throw new Error("Failed to persist provider webhook event");
  }

  try {
    return await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, webhookEventId))
        .for("update")
        .limit(1);

      if (!locked) throw new Error("Webhook inbox row disappeared");
      if (locked.applicationId !== applicationId) {
        throw new InvalidNormalizedCommerceEventError(
          "Webhook inbox application mismatch",
        );
      }

      if (locked.status === "processed" || locked.status === "ignored") {
        return {
          webhookEventId,
          duplicate: true,
          status: locked.status,
          normalizedType: locked.normalizedType,
        };
      }

      // Round-3 fix (external review): re-arm a failed row with the CURRENT
      // delivery's payload. The first attempt may have failed precisely
      // because its payload was incomplete (e.g. a renewal missing
      // periodEnd); reprocessing the stale persisted copy would fail forever
      // instead of letting the provider redelivery self-heal. We hold the
      // inbox row lock, so this refresh is race-free.
      let storedEvent = locked.normalizedEvent;
      if (locked.status === "failed") {
        await tx
          .update(webhookEvents)
          .set({
            rawBody: input.rawBody,
            normalizedEvent: normalized as unknown as Record<string, unknown>,
            normalizedType: normalized.type,
            providerEventName: normalized.providerEventName,
            errorMessage: null,
          })
          .where(eq(webhookEvents.id, webhookEventId));
        storedEvent = normalized as unknown as Record<string, unknown>;
      }

      const event = asStoredNormalizedEvent(storedEvent);
      if (event.type === "unknown") {
        await tx
          .update(webhookEvents)
          .set({
            status: "ignored",
            errorMessage: null,
            processedAt: new Date(),
          })
          .where(eq(webhookEvents.id, webhookEventId));

        return {
          webhookEventId,
          duplicate: Boolean(!inserted),
          status: "ignored" as const,
          normalizedType: event.type,
        };
      }

      let order:
        | {
            id: string;
            applicationCustomerId: string;
            billingMode: string;
            status: string;
            currency: string;
            totalAmountMinor: number;
          }
        | undefined;

      if (event.monetplaneOrderId) {
        [order] = await tx
          .select({
            id: orders.id,
            applicationCustomerId: orders.applicationCustomerId,
            billingMode: orders.billingMode,
            status: orders.status,
            currency: orders.currency,
            totalAmountMinor: orders.totalAmountMinor,
          })
          .from(orders)
          .where(
            and(
              eq(orders.id, event.monetplaneOrderId),
              eq(orders.applicationId, applicationId),
            ),
          )
          .limit(1);
      }

      let mappedApplicationCustomer:
        | { id: string; customerId: string }
        | undefined;
      if (event.monetplaneCustomerId) {
        [mappedApplicationCustomer] = await tx
          .select({
            id: applicationCustomers.id,
            customerId: applicationCustomers.customerId,
          })
          .from(applicationCustomers)
          .where(
            and(
              eq(applicationCustomers.applicationId, applicationId),
              eq(applicationCustomers.customerId, event.monetplaneCustomerId),
            ),
          )
          .limit(1);
      }

      // Dispatch to the event-family handlers. The payment handler may
      // return an early outcome (idempotent replay / ignored anomaly); it
      // writes its locked order/customer reads back into the context for
      // the subscription handler of the same delivery.
      const ctx: WebhookProcessingContext = {
        tx,
        applicationId,
        providerConnectionId,
        environment,
        webhookEventId,
        event,
        occurredAt,
        inserted: Boolean(inserted),
        order,
        mappedApplicationCustomer,
      };

      const isPaymentEvent =
        event.type === "payment.succeeded" ||
        event.type === "payment.failed" ||
        event.type === "payment.refunded";
      if (isPaymentEvent) {
        const earlyOutcome = await applyPaymentEvent(ctx);
        if (earlyOutcome) return earlyOutcome;
      }

      const isSubscriptionLifecycleEvent =
        event.type.startsWith("subscription.");
      const isSubscriptionPaymentFailure =
        event.type === "payment.failed" &&
        Boolean(event.providerSubscriptionId);
      if (isSubscriptionLifecycleEvent || isSubscriptionPaymentFailure) {
        await applySubscriptionEvent(ctx);
      }

      await tx
        .update(webhookEvents)
        .set({
          status: "processed",
          errorMessage: null,
          processedAt: new Date(),
        })
        .where(eq(webhookEvents.id, webhookEventId));

      return {
        webhookEventId,
        duplicate: false,
        status: "processed" as const,
        normalizedType: event.type,
      };
    });
  } catch (error) {
    await db
      .update(webhookEvents)
      .set({
        status: "failed",
        errorMessage: eventErrorMessage(error),
      })
      .where(eq(webhookEvents.id, webhookEventId));
    throw error;
  }
}
