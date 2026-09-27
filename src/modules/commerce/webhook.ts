import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { prices } from "../catalog/schema";
import { grantConfiguredCreditsInTransaction } from "../credits/commerce";
import { applicationCustomers } from "../customers/schema";
import { entitlementGrants } from "../entitlements/schema";
import {
  expireEntitlementsBySource,
  grantConfiguredEntitlements,
  revokeEntitlementsBySource,
} from "../entitlements/service";
import type { NormalizedProviderEvent } from "../providers/contract";
import { verifyAndNormalizeProviderWebhook } from "../providers/runtime";
import { getProviderConnection } from "../providers/service";
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

        // MP-REV-02: serialize every lifecycle event for the same provider
        // payment, even when the payment row does not exist yet (lost or
        // out-of-order success + concurrent first refunds). The advisory lock
        // is taken before any row read, so a transaction that waits here
        // recomputes its refund plan against the winner's committed state
        // instead of planning against stale absence. Single lock, acquired
        // first — no lock-order cycle with the row locks below.
        if (event.providerPaymentId) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`commerce:payment:${providerConnectionId}:${event.providerPaymentId}`}, 0))`,
          );
        }

        // Lock any existing payment row first: it is the serialization point
        // for refund accounting and settled-value immutability (audit B5).
        const [existingPayment] = await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.providerConnectionId, providerConnectionId),
              eq(payments.providerPaymentId, event.providerPaymentId),
            ),
          )
          .for("update")
          .limit(1);

        // Invariant A (audit B5): a payment event that carries a currency
        // must match the currency the order/payment was captured in.
        // Comparison is case-insensitive; stored currency is canonical
        // uppercase. A mismatched event is rejected without touching the
        // recorded payment/order rows (the tx rolls back).
        const eventCurrency = event.currency?.trim().toUpperCase();
        const expectedCurrency = (
          order?.currency ?? existingPayment?.currency
        )?.toUpperCase();
        if (
          eventCurrency &&
          expectedCurrency &&
          eventCurrency !== expectedCurrency
        ) {
          throw new InvalidNormalizedCommerceEventError(
            `currency mismatch: event currency ${eventCurrency} does not match recorded currency ${expectedCurrency}`,
          );
        }

        // For a refund arriving before any success event (missed or
        // out-of-order delivery), the event amount is the refund amount, not
        // the captured amount — seed the payment row from the order total so
        // the refund cap has the right base (verifier finding on B5).
        const amountMinor =
          event.type === "payment.refunded" && !existingPayment
            ? (order?.totalAmountMinor ?? event.amountMinor)
            : (event.amountMinor ??
              order?.totalAmountMinor ??
              existingPayment?.amountMinor);
        const currency = (
          event.currency ??
          order?.currency ??
          existingPayment?.currency
        )?.toUpperCase();
        if (amountMinor === undefined || !currency) {
          throw new InvalidNormalizedCommerceEventError(
            "Payment event is missing amount or currency",
          );
        }

        // Invariants C & D (audit B5): cap the refund at the payment's
        // captured amount and only treat a cumulative-full refund as
        // terminal. The locked payment row serializes concurrent refunds.
        let refundPlan: { amountMinor: number; fullyRefunded: boolean } | null =
          null;
        if (event.type === "payment.refunded") {
          // MP-REV-01: a refund fact is identified by (connection,
          // providerRefundId) — NOT by the inbox event id. A second event
          // carrying the same refund id replays or conflicts with the SAME
          // fact; it must never be planned as new refund headroom, and a
          // succeeded refund row is an immutable business fact.
          if (event.providerRefundId) {
            const [recordedFact] = await tx
              .select()
              .from(refunds)
              .where(
                and(
                  eq(refunds.providerConnectionId, providerConnectionId),
                  eq(refunds.providerRefundId, event.providerRefundId),
                ),
              )
              .for("update")
              .limit(1);
            if (recordedFact?.status === "succeeded") {
              if (recordedFact.paymentId !== existingPayment?.id) {
                // The provider is reusing a refund id across payments —
                // a provider-side inconsistency, not a replay.
                throw new InvalidNormalizedCommerceEventError(
                  `refund fact ${event.providerRefundId} conflict: already recorded for a different payment`,
                );
              }
              if (
                recordedFact.amountMinor === null ||
                event.amountMinor === undefined ||
                recordedFact.amountMinor === event.amountMinor
              ) {
                // Idempotent replay of an already-recorded refund fact:
                // acknowledge without changing any row.
                await tx
                  .update(webhookEvents)
                  .set({
                    status: "ignored",
                    errorMessage: `refund fact ${event.providerRefundId} already recorded (idempotent replay)`,
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
              // Conflicting amount for the same refund fact: never overwrite
              // a succeeded business fact. Park as failed for reconciliation.
              throw new InvalidNormalizedCommerceEventError(
                `refund fact ${event.providerRefundId} conflict: recorded amountMinor ${recordedFact.amountMinor}, event reports ${event.amountMinor} — requires reconciliation`,
              );
            }
            // A `failed` recorded row may legitimately be superseded by a
            // later success fact with the same id (provider retried and the
            // refund went through); fall through to normal planning — the
            // upsert below updates that row.
          }
          const capturedAmountMinor =
            existingPayment?.amountMinor ?? amountMinor;
          let alreadyRefunded = 0;
          let unknownRefundAmount = false;
          if (existingPayment) {
            const refundRows = await tx
              .select({
                status: refunds.status,
                amountMinor: refunds.amountMinor,
              })
              .from(refunds)
              .where(eq(refunds.paymentId, existingPayment.id))
              .for("update");
            for (const row of refundRows) {
              if (row.status === "failed") continue;
              if (row.amountMinor === null) {
                // A legacy refund row without an amount recorded a full
                // refund under the previous ingest; treat the remaining
                // amount as consumed (fail-closed).
                unknownRefundAmount = true;
              } else {
                alreadyRefunded += row.amountMinor;
              }
            }
          }
          const remaining = unknownRefundAmount
            ? 0
            : capturedAmountMinor - alreadyRefunded;
          if (remaining <= 0) {
            // Nothing left to refund: durable idempotent skip that changes
            // no payment/order/refund rows.
            await tx
              .update(webhookEvents)
              .set({
                status: "ignored",
                errorMessage: "refund exceeds payment amount",
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
          const appliedRefundMinor =
            event.amountMinor === undefined
              ? remaining
              : Math.min(event.amountMinor, remaining);
          refundPlan = {
            amountMinor: appliedRefundMinor,
            fullyRefunded:
              alreadyRefunded + appliedRefundMinor >= capturedAmountMinor,
          };
        }

        // Invariant B (audit B5): a settled payment's amount is immutable.
        // Surface amount drift on a succeeded payment without failing the
        // event or overwriting the stored value. (Refund events carry the
        // refund amount, not the payment amount, so they are excluded.)
        // Runs before the replay guards so a replayed event still surfaces
        // amount drift.
        if (
          existingPayment?.status === "succeeded" &&
          event.type !== "payment.refunded" &&
          event.amountMinor !== undefined &&
          event.amountMinor !== existingPayment.amountMinor
        ) {
          console.error(
            `[monetplane] provider event ${event.providerEventId} reports amountMinor ${event.amountMinor} for settled payment ${event.providerPaymentId} (stored ${existingPayment.amountMinor}); keeping stored amount`,
          );
        }

        // MP-REV-03: a duplicate success event for an already-succeeded
        // payment is a replay of a settled fact. Re-running the grant
        // pipeline with a new event timestamp would trip the entitlement
        // idempotency conflict (EntitlementIdempotencyConflictError) and put
        // the event into a permanent retry loop. Grants fire only if they
        // never fired for this order (refund-first seeded the payment before
        // any success event arrived); otherwise acknowledge as replay.
        if (
          event.type === "payment.succeeded" &&
          existingPayment?.status === "succeeded"
        ) {
          let grantsAlreadyApplied = false;
          if (order) {
            const [existingGrant] = await tx
              .select({ id: entitlementGrants.id })
              .from(entitlementGrants)
              .where(
                and(
                  eq(entitlementGrants.applicationId, applicationId),
                  eq(entitlementGrants.sourceType, "order"),
                  eq(entitlementGrants.sourceId, order.id),
                ),
              )
              .limit(1);
            grantsAlreadyApplied = Boolean(existingGrant);
          }
          if (!order || grantsAlreadyApplied) {
            await tx
              .update(webhookEvents)
              .set({
                status: "ignored",
                errorMessage:
                  "success event replayed for an already-succeeded payment",
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
          // No grants yet (refund-first seed): fall through so the late
          // success applies them exactly once.
        }

        // MP-REV-03: refunded is a terminal state. A late success event for
        // an already-refunded payment must not resurrect it or re-fire
        // grants — record the anomaly and acknowledge without state change.
        if (
          event.type === "payment.succeeded" &&
          existingPayment?.status === "refunded"
        ) {
          console.error(
            `[monetplane] provider event ${event.providerEventId} reports success for refunded payment ${event.providerPaymentId}; keeping refunded state`,
          );
          await tx
            .update(webhookEvents)
            .set({
              status: "ignored",
              errorMessage: "success event arrived after terminal refund",
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

        const nextPaymentStatus = (() => {
          if (event.type === "payment.succeeded") return "succeeded";
          if (event.type === "payment.failed") {
            // A failure never erases a settled fact: only a pending (or
            // absent) payment transitions to failed; succeeded and refunded
            // payments keep their status (MP-REV-03).
            return !existingPayment || existingPayment.status === "pending"
              ? "failed"
              : existingPayment.status;
          }
          // payment.refunded: a partial refund keeps the payment's current
          // status; only a cumulative-full refund flips it to `refunded`.
          // A refund creating a brand-new payment row (out-of-order
          // delivery) lands on `succeeded` — never terminal on insert.
          return refundPlan?.fullyRefunded
            ? "refunded"
            : (existingPayment?.status ?? "succeeded");
        })();

        const [payment] = await tx
          .insert(payments)
          .values({
            id: `pay_${randomUUID()}`,
            applicationId,
            orderId: order?.id ?? null,
            customerId: mappedApplicationCustomer?.customerId ?? null,
            providerConnectionId,
            providerPaymentId: event.providerPaymentId,
            environment,
            status: nextPaymentStatus,
            amountMinor,
            currency,
          })
          .onConflictDoUpdate({
            target: [payments.providerConnectionId, payments.providerPaymentId],
            set: {
              status: nextPaymentStatus,
              orderId: order?.id ?? null,
              customerId: mappedApplicationCustomer?.customerId ?? null,
              updatedAt: new Date(),
              // amountMinor/currency intentionally omitted: once recorded, a
              // payment's captured amount and currency are immutable (B5).
            },
          })
          .returning();

        if (!payment) throw new Error("Failed to persist payment");

        if (order) {
          const nextOrderStatus = (() => {
            if (event.type === "payment.succeeded") {
              // refunded is terminal for orders too (MP-REV-03).
              return order.status === "refunded" ? "refunded" : "paid";
            }
            if (event.type === "payment.failed") {
              return order.status === "pending" ? "failed" : order.status;
            }
            // payment.refunded: only a cumulative-full refund closes the
            // order; a partial refund keeps the current status.
            return refundPlan?.fullyRefunded ? "refunded" : order.status;
          })();

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
                .select({
                  productId: orderItems.productId,
                  quantity: orderItems.quantity,
                })
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
                  environment,
                },
                tx,
              );
              await grantConfiguredCreditsInTransaction(
                {
                  applicationId,
                  applicationCustomerId: order.applicationCustomerId,
                  productItems: items,
                  transactionType: "grant.purchase",
                  sourceType: "order",
                  sourceId: order.id,
                  environment,
                  sourceEventId: event.providerEventId,
                  periodKey: "durable",
                },
                tx,
              );
            }
          }
        }

        if (refundPlan) {
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
              environment,
              status: "succeeded",
              amountMinor: refundPlan.amountMinor,
            })
            .onConflictDoUpdate({
              target: [refunds.providerConnectionId, refunds.providerRefundId],
              set: {
                status: "succeeded",
                amountMinor: refundPlan.amountMinor,
                updatedAt: new Date(),
              },
            });

          // Invariant D (audit B5): entitlements are only revoked once the
          // cumulative refunded amount reaches the captured payment amount.
          if (refundPlan.fullyRefunded && order) {
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
            environment,
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
            .select({
              productId: orderItems.productId,
              priceId: orderItems.priceId,
              quantity: orderItems.quantity,
              unitAmountMinor: orderItems.unitAmountMinor,
              currency: prices.currency,
              recurringInterval: prices.recurringInterval,
              trialPeriodDays: prices.trialPeriodDays,
            })
            .from(orderItems)
            .innerJoin(prices, eq(prices.id, orderItems.priceId))
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
                  unitAmountMinor: item.unitAmountMinor,
                  currency: item.currency,
                  recurringInterval: item.recurringInterval,
                  trialPeriodDays: item.trialPeriodDays ?? null,
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
            .select({
              productId: subscriptionItems.productId,
              quantity: subscriptionItems.quantity,
            })
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
              environment,
            },
            tx,
          );

          const grantsCredits =
            event.type === "subscription.activated" ||
            event.type === "subscription.renewed";
          if (grantsCredits) {
            await grantConfiguredCreditsInTransaction(
              {
                applicationId,
                applicationCustomerId,
                productItems: items,
                transactionType: "grant.subscription",
                sourceType: "subscription",
                sourceId: subscription.id,
                environment,
                sourceEventId: event.providerEventId,
                periodKey: periodStart.toISOString(),
              },
              tx,
            );
          }
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
