import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
} from "drizzle-orm";
import { getDb } from "@/db/client";
import { prices, productGrantConfigs, products } from "@/modules/catalog/schema";
import {
  orderItems,
  orders,
  payments,
  refunds,
  subscriptionItems,
  subscriptions,
  webhookEvents,
} from "@/modules/commerce/schema";
import { applicationCustomers } from "@/modules/customers/schema";
import { billingOperations } from "@/modules/operations/schema";
import type { ProviderMode } from "@/modules/providers/contract";
import { getProviderCapabilities } from "@/modules/providers/runtime";
import { providerConnections } from "@/modules/providers/schema";

export type BillingOperationsFilter = {
  status?: string;
  customer?: string;
  product?: string;
  providerConnectionId?: string;
  from?: string;
  to?: string;
  providerMode?: ProviderMode;
  resourceId?: string;
};

export type OperationEligibility = {
  eligible: boolean;
  reason: string | null;
};

function parseStartDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseEndDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizedEventString(
  event: Record<string, unknown>,
  key: string,
): string | null {
  const value = event[key];
  return typeof value === "string" ? value : null;
}

async function loadOrderItems(orderIds: string[]) {
  if (orderIds.length === 0) return [];
  const db = getDb();
  return db
    .select({
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      productKey: products.key,
      productName: products.name,
      priceId: orderItems.priceId,
      quantity: orderItems.quantity,
      unitAmountMinor: orderItems.unitAmountMinor,
    })
    .from(orderItems)
    .leftJoin(products, eq(orderItems.productId, products.id))
    .where(inArray(orderItems.orderId, orderIds));
}

async function loadSubscriptionItems(subscriptionIds: string[]) {
  if (subscriptionIds.length === 0) return [];
  const db = getDb();
  return db
    .select({
      subscriptionId: subscriptionItems.subscriptionId,
      productId: subscriptionItems.productId,
      productKey: products.key,
      productName: products.name,
      priceId: subscriptionItems.priceId,
      quantity: subscriptionItems.quantity,
      amountMinor: prices.amountMinor,
      currency: prices.currency,
      recurringInterval: prices.recurringInterval,
    })
    .from(subscriptionItems)
    .leftJoin(products, eq(subscriptionItems.productId, products.id))
    .leftJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(inArray(subscriptionItems.subscriptionId, subscriptionIds));
}

function matchesProduct(
  productFilter: string | undefined,
  items: Array<{ productKey: string | null; productName: string | null }>,
) {
  const normalized = productFilter?.trim().toLowerCase();
  if (!normalized) return true;
  return items.some(
    (item) =>
      item.productKey?.toLowerCase().includes(normalized) ||
      item.productName?.toLowerCase().includes(normalized),
  );
}

export async function getPaymentsList(
  applicationId: string,
  filter: BillingOperationsFilter = {},
) {
  const db = getDb();
  const from = parseStartDate(filter.from);
  const to = parseEndDate(filter.to);
  const customerQuery = filter.customer?.trim();

  const rows = await db
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
      billingMode: orders.billingMode,
      orderStatus: orders.status,
      applicationCustomerId: applicationCustomers.id,
      externalCustomerId: applicationCustomers.externalCustomerId,
      customerEmail: applicationCustomers.email,
      provider: providerConnections.provider,
      providerName: providerConnections.name,
      providerMode: providerConnections.mode,
    })
    .from(payments)
    .leftJoin(orders, eq(payments.orderId, orders.id))
    .leftJoin(
      applicationCustomers,
      and(
        eq(orders.applicationCustomerId, applicationCustomers.id),
        eq(applicationCustomers.applicationId, applicationId),
      ),
    )
    .leftJoin(
      providerConnections,
      eq(payments.providerConnectionId, providerConnections.id),
    )
    .where(
      and(
        eq(payments.applicationId, applicationId),
        filter.resourceId ? eq(payments.id, filter.resourceId) : undefined,
        filter.status ? eq(payments.status, filter.status) : undefined,
        filter.providerConnectionId
          ? eq(payments.providerConnectionId, filter.providerConnectionId)
          : undefined,
        filter.providerMode
          ? eq(providerConnections.mode, filter.providerMode)
          : undefined,
        from ? gte(payments.createdAt, from) : undefined,
        to ? lte(payments.createdAt, to) : undefined,
        customerQuery
          ? or(
              ilike(
                applicationCustomers.externalCustomerId,
                `%${customerQuery}%`,
              ),
              ilike(applicationCustomers.email, `%${customerQuery}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(filter.resourceId ? 1 : 200);

  const orderIds = rows.flatMap((row) => (row.orderId ? [row.orderId] : []));
  const paymentIds = rows.map((row) => row.id);
  const [itemRows, refundRows, operationRows] = await Promise.all([
    loadOrderItems(orderIds),
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
      : Promise.resolve([]),
    paymentIds.length > 0
      ? db
          .select()
          .from(billingOperations)
          .where(
            and(
              eq(billingOperations.applicationId, applicationId),
              eq(billingOperations.resourceType, "payment"),
              inArray(billingOperations.resourceId, paymentIds),
            ),
          )
          .orderBy(desc(billingOperations.createdAt))
      : Promise.resolve([]),
  ]);

  const itemsByOrder = new Map<string, typeof itemRows>();
  for (const item of itemRows) {
    const items = itemsByOrder.get(item.orderId) ?? [];
    items.push(item);
    itemsByOrder.set(item.orderId, items);
  }
  const refundsByPayment = new Map<string, typeof refundRows>();
  for (const refund of refundRows) {
    const list = refundsByPayment.get(refund.paymentId) ?? [];
    list.push(refund);
    refundsByPayment.set(refund.paymentId, list);
  }
  const operationsByPayment = new Map<string, typeof operationRows>();
  for (const operation of operationRows) {
    const list = operationsByPayment.get(operation.resourceId) ?? [];
    list.push(operation);
    operationsByPayment.set(operation.resourceId, list);
  }

  return rows
    .map((row) => ({
      ...row,
      items: row.orderId ? (itemsByOrder.get(row.orderId) ?? []) : [],
      refunds: refundsByPayment.get(row.id) ?? [],
      operations: operationsByPayment.get(row.id) ?? [],
    }))
    .filter((row) => matchesProduct(filter.product, row.items));
}

export async function getPaymentDetail(
  applicationId: string,
  paymentId: string,
  providerMode?: ProviderMode,
) {
  const rows = await getPaymentsList(applicationId, {
    resourceId: paymentId,
    providerMode,
  });
  const payment = rows[0];
  if (!payment) throw new Error("Payment not found in the selected project/environment");

  const db = getDb();
  const [events, eligibility] = await Promise.all([
    db
      .select({
        id: webhookEvents.id,
        normalizedType: webhookEvents.normalizedType,
        providerEventName: webhookEvents.providerEventName,
        status: webhookEvents.status,
        occurredAt: webhookEvents.occurredAt,
        normalizedEvent: webhookEvents.normalizedEvent,
      })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.applicationId, applicationId),
          eq(webhookEvents.providerConnectionId, payment.providerConnectionId),
        ),
      )
      .orderBy(desc(webhookEvents.occurredAt))
      .limit(200),
    getRefundEligibility(applicationId, payment),
  ]);

  const relatedEvents = events.filter((event) => {
    const providerPaymentId = normalizedEventString(
      event.normalizedEvent,
      "providerPaymentId",
    );
    const monetplaneOrderId = normalizedEventString(
      event.normalizedEvent,
      "monetplaneOrderId",
    );
    return (
      providerPaymentId === payment.providerPaymentId ||
      (payment.orderId !== null && monetplaneOrderId === payment.orderId)
    );
  });

  return { ...payment, events: relatedEvents, refundEligibility: eligibility };
}

async function getRefundEligibility(
  applicationId: string,
  payment: Awaited<ReturnType<typeof getPaymentsList>>[number],
): Promise<OperationEligibility> {
  if (payment.status !== "succeeded") {
    return { eligible: false, reason: "Only succeeded payments can be refunded." };
  }
  if (!payment.orderId || payment.billingMode !== "one_time") {
    return {
      eligible: false,
      reason: "Subscription payments are handled from the subscription operations flow.",
    };
  }
  if (payment.refunds.some((refund) => refund.status !== "failed")) {
    return { eligible: false, reason: "A refund already exists for this payment." };
  }
  if (payment.amountMinor <= 0) {
    return { eligible: false, reason: "Zero-value payments cannot be refunded." };
  }

  const db = getDb();
  const productIds = [...new Set(payment.items.map((item) => item.productId))];
  if (productIds.length > 0) {
    const creditGrant = await db
      .select({ id: productGrantConfigs.id })
      .from(productGrantConfigs)
      .where(
        and(
          inArray(productGrantConfigs.productId, productIds),
          eq(productGrantConfigs.grantType, "credit"),
        ),
      )
      .limit(1);
    if (creditGrant.length > 0) {
      return {
        eligible: false,
        reason:
          "This purchase granted credits and no safe credit clawback policy is configured.",
      };
    }
  }

  try {
    const capabilities = await getProviderCapabilities(
      applicationId,
      payment.providerConnectionId,
    );
    if (!capabilities.refund) {
      return {
        eligible: false,
        reason: "The connected provider does not support refunds.",
      };
    }
  } catch {
    return {
      eligible: false,
      reason: "Provider capabilities are unavailable for this payment.",
    };
  }

  return { eligible: true, reason: null };
}

export async function getSubscriptionsList(
  applicationId: string,
  filter: BillingOperationsFilter = {},
) {
  const db = getDb();
  const from = parseStartDate(filter.from);
  const to = parseEndDate(filter.to);
  const customerQuery = filter.customer?.trim();

  const rows = await db
    .select({
      id: subscriptions.id,
      applicationCustomerId: subscriptions.applicationCustomerId,
      providerConnectionId: subscriptions.providerConnectionId,
      providerSubscriptionId: subscriptions.providerSubscriptionId,
      status: subscriptions.status,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      createdAt: subscriptions.createdAt,
      updatedAt: subscriptions.updatedAt,
      externalCustomerId: applicationCustomers.externalCustomerId,
      customerEmail: applicationCustomers.email,
      provider: providerConnections.provider,
      providerName: providerConnections.name,
      providerMode: providerConnections.mode,
    })
    .from(subscriptions)
    .leftJoin(
      applicationCustomers,
      and(
        eq(subscriptions.applicationCustomerId, applicationCustomers.id),
        eq(applicationCustomers.applicationId, applicationId),
      ),
    )
    .leftJoin(
      providerConnections,
      eq(subscriptions.providerConnectionId, providerConnections.id),
    )
    .where(
      and(
        eq(subscriptions.applicationId, applicationId),
        filter.resourceId
          ? eq(subscriptions.id, filter.resourceId)
          : undefined,
        filter.status ? eq(subscriptions.status, filter.status) : undefined,
        filter.providerConnectionId
          ? eq(subscriptions.providerConnectionId, filter.providerConnectionId)
          : undefined,
        filter.providerMode
          ? eq(providerConnections.mode, filter.providerMode)
          : undefined,
        from ? gte(subscriptions.createdAt, from) : undefined,
        to ? lte(subscriptions.createdAt, to) : undefined,
        customerQuery
          ? or(
              ilike(
                applicationCustomers.externalCustomerId,
                `%${customerQuery}%`,
              ),
              ilike(applicationCustomers.email, `%${customerQuery}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(subscriptions.updatedAt))
    .limit(filter.resourceId ? 1 : 200);

  const subscriptionIds = rows.map((row) => row.id);
  const [itemRows, operationRows] = await Promise.all([
    loadSubscriptionItems(subscriptionIds),
    subscriptionIds.length > 0
      ? db
          .select()
          .from(billingOperations)
          .where(
            and(
              eq(billingOperations.applicationId, applicationId),
              eq(billingOperations.resourceType, "subscription"),
              inArray(billingOperations.resourceId, subscriptionIds),
            ),
          )
          .orderBy(desc(billingOperations.createdAt))
      : Promise.resolve([]),
  ]);

  const itemsBySubscription = new Map<string, typeof itemRows>();
  for (const item of itemRows) {
    const items = itemsBySubscription.get(item.subscriptionId) ?? [];
    items.push(item);
    itemsBySubscription.set(item.subscriptionId, items);
  }
  const operationsBySubscription = new Map<string, typeof operationRows>();
  for (const operation of operationRows) {
    const list = operationsBySubscription.get(operation.resourceId) ?? [];
    list.push(operation);
    operationsBySubscription.set(operation.resourceId, list);
  }

  return rows
    .map((row) => ({
      ...row,
      items: itemsBySubscription.get(row.id) ?? [],
      operations: operationsBySubscription.get(row.id) ?? [],
    }))
    .filter((row) => matchesProduct(filter.product, row.items));
}

export async function getSubscriptionDetail(
  applicationId: string,
  subscriptionId: string,
  providerMode?: ProviderMode,
) {
  const rows = await getSubscriptionsList(applicationId, {
    resourceId: subscriptionId,
    providerMode,
  });
  const subscription = rows[0];
  if (!subscription) {
    throw new Error("Subscription not found in the selected project/environment");
  }

  const db = getDb();
  const [events, eligibility] = await Promise.all([
    db
      .select({
        id: webhookEvents.id,
        normalizedType: webhookEvents.normalizedType,
        providerEventName: webhookEvents.providerEventName,
        status: webhookEvents.status,
        occurredAt: webhookEvents.occurredAt,
        normalizedEvent: webhookEvents.normalizedEvent,
      })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.applicationId, applicationId),
          eq(
            webhookEvents.providerConnectionId,
            subscription.providerConnectionId,
          ),
        ),
      )
      .orderBy(desc(webhookEvents.occurredAt))
      .limit(200),
    getCancellationEligibility(applicationId, subscription),
  ]);

  const relatedEvents = events.filter(
    (event) =>
      normalizedEventString(
        event.normalizedEvent,
        "providerSubscriptionId",
      ) === subscription.providerSubscriptionId,
  );

  return {
    ...subscription,
    events: relatedEvents,
    cancellationEligibility: eligibility,
  };
}

async function getCancellationEligibility(
  applicationId: string,
  subscription: Awaited<ReturnType<typeof getSubscriptionsList>>[number],
): Promise<OperationEligibility> {
  if (["cancelled", "expired"].includes(subscription.status)) {
    return { eligible: false, reason: "This subscription is already terminal." };
  }
  try {
    const capabilities = await getProviderCapabilities(
      applicationId,
      subscription.providerConnectionId,
    );
    if (!capabilities.subscription_cancel) {
      return {
        eligible: false,
        reason:
          "The connected provider does not support subscription cancellation.",
      };
    }
  } catch {
    return {
      eligible: false,
      reason: "Provider capabilities are unavailable for this subscription.",
    };
  }
  return { eligible: true, reason: null };
}

export async function getRefundsList(
  applicationId: string,
  filter: BillingOperationsFilter = {},
) {
  const db = getDb();
  const from = parseStartDate(filter.from);
  const to = parseEndDate(filter.to);
  const customerQuery = filter.customer?.trim();

  const rows = await db
    .select({
      id: refunds.id,
      paymentId: refunds.paymentId,
      orderId: refunds.orderId,
      providerConnectionId: refunds.providerConnectionId,
      providerRefundId: refunds.providerRefundId,
      status: refunds.status,
      amountMinor: refunds.amountMinor,
      createdAt: refunds.createdAt,
      updatedAt: refunds.updatedAt,
      paymentCurrency: payments.currency,
      applicationCustomerId: applicationCustomers.id,
      externalCustomerId: applicationCustomers.externalCustomerId,
      customerEmail: applicationCustomers.email,
      provider: providerConnections.provider,
      providerName: providerConnections.name,
      providerMode: providerConnections.mode,
    })
    .from(refunds)
    .leftJoin(payments, eq(refunds.paymentId, payments.id))
    .leftJoin(orders, eq(refunds.orderId, orders.id))
    .leftJoin(
      applicationCustomers,
      and(
        eq(orders.applicationCustomerId, applicationCustomers.id),
        eq(applicationCustomers.applicationId, applicationId),
      ),
    )
    .leftJoin(
      providerConnections,
      eq(refunds.providerConnectionId, providerConnections.id),
    )
    .where(
      and(
        eq(refunds.applicationId, applicationId),
        filter.resourceId ? eq(refunds.id, filter.resourceId) : undefined,
        filter.status ? eq(refunds.status, filter.status) : undefined,
        filter.providerConnectionId
          ? eq(refunds.providerConnectionId, filter.providerConnectionId)
          : undefined,
        filter.providerMode
          ? eq(providerConnections.mode, filter.providerMode)
          : undefined,
        from ? gte(refunds.createdAt, from) : undefined,
        to ? lte(refunds.createdAt, to) : undefined,
        customerQuery
          ? or(
              ilike(
                applicationCustomers.externalCustomerId,
                `%${customerQuery}%`,
              ),
              ilike(applicationCustomers.email, `%${customerQuery}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(refunds.createdAt))
    .limit(filter.resourceId ? 1 : 200);

  const orderIds = rows.flatMap((row) => (row.orderId ? [row.orderId] : []));
  const itemRows = await loadOrderItems(orderIds);
  const itemsByOrder = new Map<string, typeof itemRows>();
  for (const item of itemRows) {
    const items = itemsByOrder.get(item.orderId) ?? [];
    items.push(item);
    itemsByOrder.set(item.orderId, items);
  }

  return rows
    .map((row) => ({
      ...row,
      items: row.orderId ? (itemsByOrder.get(row.orderId) ?? []) : [],
    }))
    .filter((row) => matchesProduct(filter.product, row.items));
}

export async function getRefundDetail(
  applicationId: string,
  refundId: string,
  providerMode?: ProviderMode,
) {
  const refundsList = await getRefundsList(applicationId, {
    resourceId: refundId,
    providerMode,
  });
  const refund = refundsList[0];
  if (!refund) throw new Error("Refund not found in the selected project/environment");

  const payment = await getPaymentDetail(
    applicationId,
    refund.paymentId,
    providerMode,
  );
  return { ...refund, payment };
}

export async function getOperationById(
  applicationId: string,
  operationId: string,
) {
  const db = getDb();
  const [operation] = await db
    .select()
    .from(billingOperations)
    .where(
      and(
        eq(billingOperations.id, operationId),
        eq(billingOperations.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (!operation) throw new Error("Billing operation not found");
  return operation;
}

export async function getProviderFilterOptions(
  applicationId: string,
  providerMode?: ProviderMode,
) {
  const db = getDb();
  return db
    .select({
      id: providerConnections.id,
      provider: providerConnections.provider,
      name: providerConnections.name,
      mode: providerConnections.mode,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.applicationId, applicationId),
        providerMode ? eq(providerConnections.mode, providerMode) : undefined,
      ),
    )
    .orderBy(providerConnections.name);
}
