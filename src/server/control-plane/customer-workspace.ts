import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { prices, products } from "@/modules/catalog/schema";
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
import { grantCreditsInTransaction } from "@/modules/credits/service";
import { applicationCustomers } from "@/modules/customers/schema";
import { entitlementGrants } from "@/modules/entitlements/schema";
import { getProviderCapabilities } from "@/modules/providers/runtime";
import { providerConnections } from "@/modules/providers/schema";
import { recordAuditEntry, resolveSessionActor } from "./audit";

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
  environment: "test" | "live" = "test",
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
          eq(creditAccounts.environment, environment),
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

  const creditState = new Map<
    string,
    { available: number; reserved: number }
  >();
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
  environment: "test" | "live" = "test",
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
          eq(creditAccounts.environment, environment),
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
          eq(creditTransactions.environment, environment),
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
          eq(entitlementGrants.environment, environment),
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
      ? (orderRows.find((candidate) => candidate.id === row.orderId) ?? null)
      : null;
    const orderProductIds = order
      ? (itemsByOrder.get(order.id) ?? []).map((item) => item.productId)
      : [];
    return {
      ...row,
      order,
      orderItems: order ? (itemsByOrder.get(order.id) ?? []) : [],
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
  input: {
    creditType: string;
    amount: number;
    note?: string;
    /**
     * Client-supplied retry token (audit M5). Without one, every call
     * generates a fresh idempotency key, so a network retry after a
     * successful grant double-credits the customer. When provided, the
     * same retry of the same logical grant resolves to the same ledger
     * entry. Scoped per customer inside the composed key.
     */
    idempotencyKey?: string;
    /**
     * Optional bucket expiry (roundtable 2026-10-06, PR4): the credits
     * service has supported expiresAt since the bucket model landed, but
     * the admin route never parsed it — the expiry cron had no UI entry.
     */
    expiresAt?: Date | null;
  },
  environment: "test" | "live" = "test",
  audit?: {
    /**
     * When present, the audit row is written INSIDE the grant's
     * transaction (project review 2026-10-04, roundtable batch 1) — a
     * crash between ledger write and audit write can no longer lose the
     * audit trail for a granted mutation.
     */
    request?: Request;
    actor?: { id: string; label?: string | null };
  },
) {
  await requireApplicationCustomer(applicationId, applicationCustomerId);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new Error("Credit amount must be a positive whole number");
  }

  const clientKey = input.idempotencyKey?.trim();
  const sourceId = clientKey ? `admin_${clientKey}` : `admin_${randomUUID()}`;
  // Resolve the session actor before opening the transaction: auth() must
  // not run inside the tx callback.
  const actor =
    audit?.actor ?? (audit ? await resolveSessionActor() : undefined);
  return getDb().transaction(async (tx) => {
    const result = await grantCreditsInTransaction(
      {
        applicationId,
        applicationCustomerId,
        creditType: input.creditType,
        amount: input.amount,
        transactionType: "adjustment.admin",
        sourceType: "admin",
        sourceId,
        environment,
        idempotencyKey: `admin-credit:${applicationCustomerId}:${sourceId}`,
        metadata: { note: input.note?.trim() || undefined },
        expiresAt: input.expiresAt ?? null,
      },
      tx,
    );
    if (audit) {
      await recordAuditEntry(
        {
          applicationId,
          environment,
          action: "credits.granted",
          resourceType: "credit_transaction",
          resourceId: result.transaction.id,
          metadata: {
            customerId: applicationCustomerId,
            amount: input.amount,
            creditType: input.creditType,
          },
          request: audit.request,
          ...(actor ? { actor } : {}),
        },
        tx,
      );
    }
    return result;
  });
}
