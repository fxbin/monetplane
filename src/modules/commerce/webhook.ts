import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { applicationCustomers } from "../customers/schema";
import {
  expireEntitlementsBySource,
  grantConfiguredEntitlements,
  revokeEntitlementsBySource,
} from "../entitlements/service";
import type { NormalizedProviderEvent } from "../providers/contract";
import { verifyAndNormalizeProviderWebhook } from "../providers/runtime";
import {
  checkoutSessions,
  orderItems,
  orders,
  payments,
  refunds,
  subscriptionItems,
  subscriptions,
  webhookEvents,
} from "./schema";

export class InvalidNormalizedCommerceEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNormalizedCommerceEventError";
  }
}

function parseEventDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidNormalizedCommerceEventError(
      "Invalid provider event date",
    );
  }
  return date;
}

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

      const event = asStoredNormalizedEvent(locked.normalizedEvent);
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

      if (
        event.type === "payment.succeeded" ||
        event.type === "payment.failed" ||
        event.type === "payment.refunded"
      ) {
        if (!event.providerPaymentId) {
          throw new InvalidNormalizedCommerceEventError(
            "Payment event is missing providerPaymentId",
          );
        }

        const amountMinor = event.amountMinor ?? order?.totalAmountMinor;
        const currency = event.currency ?? order?.currency;
        if (amountMinor === undefined || !currency) {
          throw new InvalidNormalizedCommerceEventError(
            "Payment event is missing amount or currency",
          );
        }

        const paymentStatus =
          event.type === "payment.succeeded"
            ? "succeeded"
            : event.type === "payment.failed"
              ? "failed"
              : "refunded";

        const [payment] = await tx
          .insert(payments)
          .values({
            id: `pay_${randomUUID()}`,
            applicationId,
            orderId: order?.id ?? null,
            customerId: mappedApplicationCustomer?.customerId ?? null,
            providerConnectionId,
            providerPaymentId: event.providerPaymentId,
            status: paymentStatus,
            amountMinor,
            currency,
          })
          .onConflictDoUpdate({
            target: [payments.providerConnectionId, payments.providerPaymentId],
            set: {
              status: paymentStatus,
              orderId: order?.id ?? null,
              customerId: mappedApplicationCustomer?.customerId ?? null,
              amountMinor,
              currency,
              updatedAt: new Date(),
            },
          })
          .returning();

        if (!payment) throw new Error("Failed to persist payment");

        if (order) {
          const nextOrderStatus =
            event.type === "payment.succeeded"
              ? "paid"
              : event.type === "payment.failed"
                ? order.status === "pending"
                  ? "failed"
                  : order.status
                : "refunded";

          await tx
            .update(orders)
            .set({ status: nextOrderStatus, updatedAt: new Date() })
            .where(
              and(
                eq(orders.id, order.id),
                eq(orders.applicationId, applicationId),
              ),
            );

          if (event.type === "payment.succeeded") {
            await tx
              .update(checkoutSessions)
              .set({ status: "completed", updatedAt: new Date() })
              .where(
                and(
                  eq(checkoutSessions.orderId, order.id),
                  eq(checkoutSessions.applicationId, applicationId),
                ),
              );

            if (order.billingMode === "one_time") {
              const items = await tx
                .select({ productId: orderItems.productId })
                .from(orderItems)
                .where(eq(orderItems.orderId, order.id));
              await grantConfiguredEntitlements(
                {
                  applicationId,
                  applicationCustomerId: order.applicationCustomerId,
                  productIds: items.map((item) => item.productId),
                  sourceType: "order",
                  sourceId: order.id,
                  sourceEventId: event.providerEventId,
                  validFrom: occurredAt,
                  validUntil: null,
                  periodKey: "durable",
                },
                tx,
              );
            }
          }
        }

        if (event.type === "payment.refunded") {
          const providerRefundId =
            event.providerRefundId ?? `event:${event.providerEventId}`;
          await tx
            .insert(refunds)
            .values({
              id: `ref_${randomUUID()}`,
              applicationId,
              orderId: order?.id ?? null,
              paymentId: payment.id,
              providerConnectionId,
              providerRefundId,
              status: "succeeded",
              amountMinor: event.amountMinor ?? null,
            })
            .onConflictDoUpdate({
              target: [refunds.providerConnectionId, refunds.providerRefundId],
              set: {
                status: "succeeded",
                amountMinor: event.amountMinor ?? null,
                updatedAt: new Date(),
              },
            });

          if (order) {
            await revokeEntitlementsBySource(
              applicationId,
              "order",
              order.id,
              tx,
            );
          }
        }
      }

      const isSubscriptionLifecycleEvent =
        event.type.startsWith("subscription.");
      const isSubscriptionPaymentFailure =
        event.type === "payment.failed" &&
        Boolean(event.providerSubscriptionId);

      if (isSubscriptionLifecycleEvent || isSubscriptionPaymentFailure) {
        if (!event.providerSubscriptionId) {
          throw new InvalidNormalizedCommerceEventError(
            "Subscription event is missing providerSubscriptionId",
          );
        }

        const [existingSubscription] = await tx
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.providerConnectionId, providerConnectionId),
              eq(
                subscriptions.providerSubscriptionId,
                event.providerSubscriptionId,
              ),
              eq(subscriptions.applicationId, applicationId),
            ),
          )
          .limit(1);

        const applicationCustomerId =
          existingSubscription?.applicationCustomerId ??
          mappedApplicationCustomer?.id ??
          order?.applicationCustomerId;
        if (!applicationCustomerId) {
          throw new InvalidNormalizedCommerceEventError(
            "Subscription event cannot be mapped to an application customer",
          );
        }

        const inferredStatus = (() => {
          if (isSubscriptionPaymentFailure) return "past_due";
          if (event.type === "subscription.created") {
            return event.subscriptionStatus ?? "pending";
          }
          if (
            event.type === "subscription.activated" ||
            event.type === "subscription.renewed"
          ) {
            return event.subscriptionStatus ?? "active";
          }
          if (event.type === "subscription.cancelled") return "cancelled";
          if (event.type === "subscription.expired") return "expired";
          return (
            event.subscriptionStatus ??
            existingSubscription?.status ??
            "pending"
          );
        })();

        const periodStart =
          parseEventDate(event.subscriptionPeriodStart) ??
          existingSubscription?.currentPeriodStart ??
          null;
        const periodEnd =
          parseEventDate(event.subscriptionPeriodEnd) ??
          existingSubscription?.currentPeriodEnd ??
          null;
        const cancelAtPeriodEnd =
          event.cancelAtPeriodEnd ??
          existingSubscription?.cancelAtPeriodEnd ??
          false;

        const [subscription] = await tx
          .insert(subscriptions)
          .values({
            id: existingSubscription?.id ?? `sub_${randomUUID()}`,
            applicationId,
            applicationCustomerId,
            providerConnectionId,
            providerSubscriptionId: event.providerSubscriptionId,
            status: inferredStatus,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd,
          })
          .onConflictDoUpdate({
            target: [
              subscriptions.providerConnectionId,
              subscriptions.providerSubscriptionId,
            ],
            set: {
              status: inferredStatus,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
              cancelAtPeriodEnd,
              updatedAt: new Date(),
            },
          })
          .returning();

        if (!subscription) throw new Error("Failed to persist subscription");

        if (!existingSubscription && order) {
          const items = await tx
            .select()
            .from(orderItems)
            .where(eq(orderItems.orderId, order.id));
          if (items.length > 0) {
            await tx
              .insert(subscriptionItems)
              .values(
                items.map((item) => ({
                  id: `subitem_${randomUUID()}`,
                  subscriptionId: subscription.id,
                  productId: item.productId,
                  priceId: item.priceId,
                  quantity: item.quantity,
                })),
              )
              .onConflictDoNothing();
          }
        }

        const grantsAccess =
          inferredStatus === "active" &&
          (event.type === "subscription.created" ||
            event.type === "subscription.activated" ||
            event.type === "subscription.renewed" ||
            event.type === "subscription.updated");

        if (grantsAccess) {
          if (!periodStart || !periodEnd) {
            throw new InvalidNormalizedCommerceEventError(
              "Active subscription entitlement requires period boundaries",
            );
          }
          const items = await tx
            .select({ productId: subscriptionItems.productId })
            .from(subscriptionItems)
            .where(eq(subscriptionItems.subscriptionId, subscription.id));
          await grantConfiguredEntitlements(
            {
              applicationId,
              applicationCustomerId,
              productIds: items.map((item) => item.productId),
              sourceType: "subscription",
              sourceId: subscription.id,
              sourceEventId: event.providerEventId,
              validFrom: periodStart,
              validUntil: periodEnd,
              periodKey: periodStart.toISOString(),
            },
            tx,
          );
        }

        if (event.type === "subscription.cancelled" && !cancelAtPeriodEnd) {
          await revokeEntitlementsBySource(
            applicationId,
            "subscription",
            subscription.id,
            tx,
          );
        }
        if (event.type === "subscription.expired") {
          await expireEntitlementsBySource(
            applicationId,
            "subscription",
            subscription.id,
            tx,
          );
        }
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
