import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  or,
} from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  prices,
  productGrantConfigs,
  products,
} from "@/modules/catalog/schema";
import {
  orderItems,
  orders,
  payments,
  refunds,
  subscriptionItems,
  subscriptions,
  webhookEvents,
} from "@/modules/commerce/schema";
import { creditAccounts, creditTransactions } from "@/modules/credits/schema";
import { grantCredits } from "@/modules/credits/service";
import { applicationCustomers } from "@/modules/customers/schema";
import { entitlementGrants } from "@/modules/entitlements/schema";
import { revokeEntitlementsBySource } from "@/modules/entitlements/service";
import { providerConnections } from "@/modules/providers/schema";
import {
  cancelProviderSubscription,
  getProviderCapabilities,
  refundProviderPayment,
} from "@/modules/providers/runtime";

export type CustomerListFilter = "all" | "subscribed" | "credits";

async function requireApplicationCustomer(
  applicationId: string,
  applicationCustomerId: string,
) {
  const db = getDb();
  const [customer] = await db
    .select()
    .from(applicationCustomers)
    .where(
      and(
        eq(applicationCustomers.id, applicationCustomerId),
        eq(applicationCustomers.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (!customer) throw new Error("Customer not found in the selected project");
  return customer;
}

export async function getCustomerWorkspaceList(
  applicationId: string,
  options: { search?: string; filter?: CustomerListFilter } = {},
) {
  const db = getDb();
  const search = options.search?.trim() ?? "";
  const filter = options.filter ?? "all";
  const searchCondition = search
    ? or(
        ilike(applicationCustomers.externalCustomerId, `%${search}%`),
        ilike(applicationCustomers.email, `%${search}%`),
      )
    : undefined;

  const rows = await db
    .select({
      id: applicationCustomers.id,
      externalCustomerId: applicationCustomers.externalCustomerId,
      email: applicationCustomers.email,
      createdAt: applicationCustomers.createdAt,
    })
    .from(applicationCustomers)
    .where(
      and(
        eq(applicationCustomers.applicationId, applicationId),
        searchCondition,
      ),
    )
    .orderBy(desc(applicationCustomers.createdAt))
    .limit(100);

  const customerIds = rows.map((row) => row.id);
  if (customerIds.length === 0) return [];

  const [subscriptionRows, creditRows] = await Promise.all([
    db
      .select({
        applicationCustomerId: subscriptions.applicationCustomerId,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.applicationId, applicationId),
          inArray(subscriptions.applicationCustomerId, customerIds),
        ),
      ),
    db
      .select({
        applicationCustomerId: creditAccounts.applicationCustomerId,
        availableBalance: creditAccounts.availableBalance,
        reservedBalance: creditAccounts.reservedBalance,
      })
      .from(creditAccounts)
      .where(
        and(
          eq(creditAccounts.applicationId, applicationId),
          inArray(creditAccounts.applicationCustomerId, customerIds),
        ),
      ),
  ]);

  const subscriptionState = new Map<
    string,
    { active: number; attention: number }
  >();
  for (const row of subscriptionRows) {
    const current = subscriptionState.get(row.applicationCustomerId) ?? {
      active: 0,
      attention: 0,
    };
    if (row.status === "active") current.active += 1;
    if (row.status === "past_due") current.attention += 1;
    subscriptionState.set(row.applicationCustomerId, current);
  }

  const creditState = new Map<string, { available: number; reserved: number }>();
  for (const row of creditRows) {
    const current = creditState.get(row.applicationCustomerId) ?? {
      available: 0,
      reserved: 0,
    };
    current.available += row.availableBalance;
    current.reserved += row.reservedBalance;
    creditState.set(row.applicationCustomerId, current);
  }

  return rows
    .map((row) => ({
      ...row,
      subscriptions: subscriptionState.get(row.id) ?? {
        active: 0,
        attention: 0,
      },
      credits: creditState.get(row.id) ?? { available: 0, reserved: 0 },
    }))
    .filter((row) => {
      if (filter === "subscribed") return row.subscriptions.active > 0;
      if (filter === "credits") return row.credits.available > 0;
      return true;
    });
}

export async function getCustomerWorkspace(
  applicationId: string,
  applicationCustomerId: string,
) {
  const db = getDb();
  const customer = await requireApplicationCustomer(
    applicationId,
    applicationCustomerId,
  );

  const [
    creditAccountRows,
    creditLedger,
    entitlementRows,
    orderRows,
    subscriptionRows,
    paymentRows,
    appEvents,
  ] = await Promise.all([
    db
      .select()
      .from(creditAccounts)
      .where(
        and(
          eq(creditAccounts.applicationId, applicationId),
          eq(creditAccounts.applicationCustomerId, applicationCustomerId),
        ),
      )
      .orderBy(desc(creditAccounts.updatedAt)),
    db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.applicationId, applicationId),
          eq(creditTransactions.applicationCustomerId, applicationCustomerId),
        ),
      )
      .orderBy(desc(creditTransactions.createdAt))
      .limit(100),
    db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, applicationId),
          eq(entitlementGrants.applicationCustomerId, applicationCustomerId),
        ),
      )
      .orderBy(desc(entitlementGrants.createdAt)),
    db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.applicationId, applicationId),
          eq(orders.applicationCustomerId, applicationCustomerId),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(50),
    db
      .select({
        id: subscriptions.id,
        status: subscriptions.status,
        providerConnectionId: subscriptions.providerConnectionId,
        providerSubscriptionId: subscriptions.providerSubscriptionId,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        createdAt: subscriptions.createdAt,
        updatedAt: subscriptions.updatedAt,
        provider: providerConnections.provider,
        providerName: providerConnections.name,
      })
      .from(subscriptions)
      .leftJoin(
        providerConnections,
        eq(subscriptions.providerConnectionId, providerConnections.id),
      )
      .where(
        and(
          eq(subscriptions.applicationId, applicationId),
          eq(subscriptions.applicationCustomerId, applicationCustomerId),
        ),
      )
      .orderBy(desc(subscriptions.updatedAt)),
    db
      .select({
        id: payments.id,
        orderId: payments.orderId,
        providerConnectionId: payments.providerConnectionId,
        providerPaymentId: payments.providerPaymentId,
        status: payments.status,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        createdAt: payments.createdAt,
        updatedAt: payments.updatedAt,
        provider: providerConnections.provider,
        providerName: providerConnections.name,
      })
      .from(payments)
      .leftJoin(
        providerConnections,
        eq(payments.providerConnectionId, providerConnections.id),
      )
      .where(
        and(
          eq(payments.applicationId, applicationId),
          eq(payments.customerId, customer.customerId),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(50),
    db
      .select({
        id: webhookEvents.id,
        providerEventName: webhookEvents.providerEventName,
        normalizedType: webhookEvents.normalizedType,
        status: webhookEvents.status,
        normalizedEvent: webhookEvents.normalizedEvent,
        occurredAt: webhookEvents.occurredAt,
        receivedAt: webhookEvents.receivedAt,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.applicationId, applicationId))
      .orderBy(desc(webhookEvents.occurredAt))
      .limit(150),
  ]);

  const orderIds = orderRows.map((row) => row.id);
  const subscriptionIds = subscriptionRows.map((row) => row.id);
  const paymentIds = paymentRows.map((row) => row.id);

  const [orderItemRows, subscriptionItemRows, refundRows] = await Promise.all([
    orderIds.length > 0
      ? db
          .select({
            orderId: orderItems.orderId,
            productId: orderItems.productId,
            productName: products.name,
            priceId: orderItems.priceId,
            quantity: orderItems.quantity,
          })
          .from(orderItems)
          .leftJoin(products, eq(orderItems.productId, products.id))
          .where(inArray(orderItems.orderId, orderIds))
      : Promise.resolve([]),
    subscriptionIds.length > 0
      ? db
          .select({
            subscriptionId: subscriptionItems.subscriptionId,
            productId: subscriptionItems.productId,
            productName: products.name,
            priceId: subscriptionItems.priceId,
            currency: prices.currency,
            amountMinor: prices.amountMinor,
            recurringInterval: prices.recurringInterval,
            quantity: subscriptionItems.quantity,
          })
          .from(subscriptionItems)
          .leftJoin(products, eq(subscriptionItems.productId, products.id))
          .leftJoin(prices, eq(subscriptionItems.priceId, prices.id))
          .where(inArray(subscriptionItems.subscriptionId, subscriptionIds))
      : Promise.resolve([]),
    paymentIds.length > 0
      ? db
          .select()
          .from(refunds)
          .where(
            and(
              eq(refunds.applicationId, applicationId),
              inArray(refunds.paymentId, paymentIds),
            ),
          )
          .orderBy(desc(refunds.createdAt))
      : Promise.resolve([]),
  ]);

  const itemsByOrder = new Map<string, typeof orderItemRows>();
  for (const item of orderItemRows) {
    const items = itemsByOrder.get(item.orderId) ?? [];
    items.push(item);
    itemsByOrder.set(item.orderId, items);
  }

  const itemsBySubscription = new Map<string, typeof subscriptionItemRows>();
  for (const item of subscriptionItemRows) {
    const items = itemsBySubscription.get(item.subscriptionId) ?? [];
    items.push(item);
    itemsBySubscription.set(item.subscriptionId, items);
  }

  const refundsByPayment = new Map<string, typeof refundRows>();
  for (const refund of refundRows) {
    const items = refundsByPayment.get(refund.paymentId) ?? [];
    items.push(refund);
    refundsByPayment.set(refund.paymentId, items);
  }

  const connectionIds = [
    ...new Set([
      ...subscriptionRows.map((row) => row.providerConnectionId),
      ...paymentRows.map((row) => row.providerConnectionId),
    ]),
  ];
  const capabilityEntries = await Promise.all(
    connectionIds.map(async (connectionId) => {
      try {
        return [
          connectionId,
          await getProviderCapabilities(applicationId, connectionId),
        ] as const;
      } catch {
        return [connectionId, null] as const;
      }
    }),
  );
  const capabilitiesByConnection = new Map(capabilityEntries);

  const customerEvents = appEvents
    .filter(
      (event) =>
        event.normalizedEvent.monetplaneCustomerId === customer.customerId,
    )
    .slice(0, 30);

  const subscriptionPriority: Record<string, number> = {
    active: 0,
    past_due: 1,
    pending: 2,
    cancelled: 3,
    expired: 4,
  };
  const enrichedSubscriptions = subscriptionRows
    .map((row) => ({
      ...row,
      items: itemsBySubscription.get(row.id) ?? [],
      canCancel:
        Boolean(
          capabilitiesByConnection.get(row.providerConnectionId)
            ?.subscription_cancel,
        ) && !["cancelled", "expired"].includes(row.status),
    }))
    .sort(
      (left, right) =>
        (subscriptionPriority[left.status] ?? 9) -
          (subscriptionPriority[right.status] ?? 9) ||
        right.updatedAt.getTime() - left.updatedAt.getTime(),
    );

  const enrichedPayments = paymentRows.map((row) => {
    const order = row.orderId
      ? orderRows.find((candidate) => candidate.id === row.orderId) ?? null
      : null;
    const orderProductIds = order
      ? (itemsByOrder.get(order.id) ?? []).map((item) => item.productId)
      : [];
    return {
      ...row,
      order,
      orderItems: order ? itemsByOrder.get(order.id) ?? [] : [],
      refunds: refundsByPayment.get(row.id) ?? [],
      canRefundProvider: Boolean(
        capabilitiesByConnection.get(row.providerConnectionId)?.refund,
      ),
      refundCandidateProductIds: orderProductIds,
    };
  });

  return {
    customer,
    creditAccounts: creditAccountRows,
    creditLedger,
    entitlements: entitlementRows,
    orders: orderRows.map((row) => ({
      ...row,
      items: itemsByOrder.get(row.id) ?? [],
    })),
    subscriptions: enrichedSubscriptions,
    currentSubscription: enrichedSubscriptions[0] ?? null,
    payments: enrichedPayments,
    events: customerEvents,
  };
}

export async function grantCustomerCredits(
  applicationId: string,
  applicationCustomerId: string,
  input: { creditType: string; amount: number; note?: string },
) {
  await requireApplicationCustomer(applicationId, applicationCustomerId);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new Error("Credit amount must be a positive whole number");
  }

  const sourceId = `admin_${randomUUID()}`;
  return grantCredits({
    applicationId,
    applicationCustomerId,
    creditType: input.creditType,
    amount: input.amount,
    transactionType: "adjustment.admin",
    sourceType: "admin",
    sourceId,
    idempotencyKey: `admin-credit:${sourceId}`,
    metadata: { note: input.note?.trim() || undefined },
  });
}

export async function cancelCustomerSubscription(
  applicationId: string,
  applicationCustomerId: string,
  subscriptionId: string,
) {
  const db = getDb();
  await requireApplicationCustomer(applicationId, applicationCustomerId);
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.applicationId, applicationId),
        eq(subscriptions.applicationCustomerId, applicationCustomerId),
      ),
    )
    .limit(1);
  if (!subscription) throw new Error("Subscription not found for this customer");
  if (["cancelled", "expired"].includes(subscription.status)) {
    throw new Error("Subscription is already in a terminal state");
  }

  const result = await cancelProviderSubscription(
    applicationId,
    subscription.providerConnectionId,
    { providerSubscriptionId: subscription.providerSubscriptionId },
  );

  await db
    .update(subscriptions)
    .set({
      status: result.status,
      currentPeriodStart: result.currentPeriodStart
        ? new Date(result.currentPeriodStart)
        : subscription.currentPeriodStart,
      currentPeriodEnd: result.currentPeriodEnd
        ? new Date(result.currentPeriodEnd)
        : subscription.currentPeriodEnd,
      cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(subscriptions.id, subscription.id),
        eq(subscriptions.applicationId, applicationId),
      ),
    );

  if (result.status === "cancelled" && !result.cancelAtPeriodEnd) {
    await revokeEntitlementsBySource(
      applicationId,
      "subscription",
      subscription.id,
    );
  }

  return result;
}

export async function refundCustomerPayment(
  applicationId: string,
  applicationCustomerId: string,
  paymentId: string,
) {
  const db = getDb();
  const customer = await requireApplicationCustomer(
    applicationId,
    applicationCustomerId,
  );
  const [payment] = await db
    .select({
      id: payments.id,
      orderId: payments.orderId,
      providerConnectionId: payments.providerConnectionId,
      providerPaymentId: payments.providerPaymentId,
      status: payments.status,
      amountMinor: payments.amountMinor,
      currency: payments.currency,
    })
    .from(payments)
    .where(
      and(
        eq(payments.id, paymentId),
        eq(payments.applicationId, applicationId),
        eq(payments.customerId, customer.customerId),
      ),
    )
    .limit(1);
  if (!payment) throw new Error("Payment not found for this customer");
  if (payment.status !== "succeeded") {
    throw new Error("Only succeeded payments can be refunded");
  }
  if (!payment.orderId) {
    throw new Error("Refund requires a payment linked to a MonetPlane order");
  }

  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, payment.orderId),
        eq(orders.applicationId, applicationId),
        eq(orders.applicationCustomerId, applicationCustomerId),
      ),
    )
    .limit(1);
  if (!order) throw new Error("Payment order was not found for this customer");
  if (order.billingMode !== "one_time") {
    throw new Error(
      "Subscription payment refunds are handled from the subscription operations flow",
    );
  }

  const purchasedItems = await db
    .select({ productId: orderItems.productId })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const productIds = [...new Set(purchasedItems.map((item) => item.productId))];
  if (productIds.length > 0) {
    const creditGrants = await db
      .select({ id: productGrantConfigs.id })
      .from(productGrantConfigs)
      .where(
        and(
          inArray(productGrantConfigs.productId, productIds),
          eq(productGrantConfigs.grantType, "credit"),
        ),
      )
      .limit(1);
    if (creditGrants.length > 0) {
      throw new Error(
        "Refund is blocked because this purchase granted credits and no safe credit clawback policy is configured",
      );
    }
  }

  const result = await refundProviderPayment(
    applicationId,
    payment.providerConnectionId,
    {
      providerPaymentId: payment.providerPaymentId,
      amountMinor: payment.amountMinor,
    },
  );

  await db.transaction(async (tx) => {
    await tx
      .insert(refunds)
      .values({
        id: `ref_${randomUUID()}`,
        applicationId,
        orderId: order.id,
        paymentId: payment.id,
        providerConnectionId: payment.providerConnectionId,
        providerRefundId: result.providerRefundId,
        status: result.status,
        amountMinor: result.amountMinor ?? payment.amountMinor,
      })
      .onConflictDoUpdate({
        target: [refunds.providerConnectionId, refunds.providerRefundId],
        set: {
          status: result.status,
          amountMinor: result.amountMinor ?? payment.amountMinor,
          updatedAt: new Date(),
        },
      });

    if (result.status === "succeeded") {
      await tx
        .update(payments)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
      await tx
        .update(orders)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      await revokeEntitlementsBySource(
        applicationId,
        "order",
        order.id,
        tx,
      );
    }
  });

  return result;
}
