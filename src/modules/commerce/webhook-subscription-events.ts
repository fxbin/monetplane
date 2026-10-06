import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { prices } from "../catalog/schema";
import { grantConfiguredCreditsInTransaction } from "../credits/commerce";
import { revokeSubscriptionCreditsInTransaction } from "../credits/revocation";
import {
  expireEntitlementsBySource,
  grantConfiguredEntitlements,
  revokeEntitlementsBySource,
} from "../entitlements/service";
import { orderItems, subscriptionItems, subscriptions } from "./schema";
import {
  InvalidNormalizedCommerceEventError,
  parseEventDate,
  type WebhookProcessingContext,
} from "./webhook-shared";

/**
 * Subscription-family events (subscription.* lifecycle plus
 * payment.failed with a providerSubscriptionId), extracted verbatim from
 * processProviderWebhook (roundtable batch 2). The inbox shell calls this
 * after the payment handler when both families match the same delivery.
 */
export async function applySubscriptionEvent(
  ctx: WebhookProcessingContext,
): Promise<void> {
  const { tx, applicationId, providerConnectionId, environment } = ctx;
  const { event } = ctx;
  const order = ctx.order;
  const mappedApplicationCustomer = ctx.mappedApplicationCustomer;

  // Called only for subscription.* lifecycle events and payment.failed
  // events carrying a providerSubscriptionId (dispatch decided upstream).
  const isSubscriptionPaymentFailure =
    event.type === "payment.failed" && Boolean(event.providerSubscriptionId);

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
        eq(subscriptions.providerSubscriptionId, event.providerSubscriptionId),
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
      event.subscriptionStatus ?? existingSubscription?.status ?? "pending"
    );
  })();

  const eventPeriodStart = parseEventDate(event.subscriptionPeriodStart);
  const eventPeriodEnd = parseEventDate(event.subscriptionPeriodEnd);
  const periodStart =
    eventPeriodStart ?? existingSubscription?.currentPeriodStart ?? null;
  const periodEnd =
    eventPeriodEnd ?? existingSubscription?.currentPeriodEnd ?? null;
  const cancelAtPeriodEnd =
    event.cancelAtPeriodEnd ?? existingSubscription?.cancelAtPeriodEnd ?? false;

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
    // A renewal that arrives without its own period boundaries must
    // not key grants off the stored (stale) period: those keys
    // collide with the previous cycle's grants, so the renewal
    // delivers nothing while the customer paid. Key grants off the
    // provider event id instead — stable across redeliveries
    // (idempotent replay), unique per billing-cycle event.
    const grantPeriodKey =
      event.type === "subscription.renewed" && !eventPeriodStart
        ? `event:${event.providerEventId}`
        : periodStart.toISOString();
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
        periodKey: grantPeriodKey,
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
          periodKey: grantPeriodKey,
          // Period-reset quota semantics (roundtable 2026-10-06, PR-B):
          // each cycle's grant expires with its cycle, so expiresAt is
          // the event's own period end. Round-2 fix (external review):
          // a RENEWAL that grants credits without its own period
          // boundary now fails closed — expiresAt NULL means "permanent
          // asset" in this ledger, and permanent credits from a
          // period-reset subscription model are a contract violation.
          // The inbox marks the event failed and the provider redelivers
          // (with boundaries) rather than us guessing or silently
          // accumulating permanent grants. Activations without boundaries
          // still grant (periodEnd may be learned later; the first-cycle
          // grant keeps entitlement delivery on the happy path).
          expiresAt: eventPeriodEnd ?? undefined,
          requireExpiry: event.type === "subscription.renewed",
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
    // Contract-termination clawback (roundtable 2026-10-06, PR-C):
    // unused cycle credits are recorded as grant.revoked (NOT expired —
    // different trigger kind, different reconciliation line).
    await revokeSubscriptionCreditsInTransaction(
      {
        applicationId,
        subscriptionId: subscription.id,
        environment,
        reason: "subscription_cancelled",
      },
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
