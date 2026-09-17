import { and, count, desc, eq, gte, isNull, sql, sum } from "drizzle-orm";
import { getDb } from "@/db/client";
import { products } from "@/modules/catalog/schema";
import {
  orderItems,
  orders,
  payments,
  subscriptions,
} from "@/modules/commerce/schema";
import { creditTransactions } from "@/modules/credits/schema";
import { applicationCustomers } from "@/modules/customers/schema";
import { providerConnections } from "@/modules/providers/schema";
import { webhookDeliveries } from "@/modules/webhooks/schema";
import type { ConsoleEnvironment } from "./context";
import { getDeveloperHealth } from "./developer";

/**
 * Overview command-center aggregation.
 *
 * Read-only queries that back the Overview page and the lightweight
 * Revenue / Usage analytics pages.
 *
 * Environment semantics follow the console contract: payments,
 * subscriptions, provider health, and webhook activity are scoped to the
 * selected environment through the provider connection mode. Credits are
 * project-wide today and are labeled as such in the UI.
 */

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthsBack(n: number): Date[] {
  const now = new Date();
  const months: Date[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    months.push(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)),
    );
  }
  return months;
}

export type OverviewWarning = {
  level: "danger" | "warning";
  message: string;
  href: string;
};

export async function getOverviewCommandCenter(
  applicationId: string,
  environment: ConsoleEnvironment,
) {
  const db = getDb();

  const [
    succeededPaymentStats,
    subscriptionStats,
    creditStats,
    recentPayments,
    topProducts,
    failedRecentPayments,
    pastDueSubscriptions,
    providerRows,
  ] = await Promise.all([
    db
      .select({
        total: sum(payments.amountMinor),
        paymentCount: count(),
      })
      .from(payments)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, payments.providerConnectionId),
      )
      .where(
        and(
          eq(payments.applicationId, applicationId),
          eq(payments.status, "succeeded"),
          eq(providerConnections.mode, environment),
        ),
      ),
    db
      .select({
        active: sql<number>`count(*) filter (where ${subscriptions.status} = 'active')`,
        pastDue: sql<number>`count(*) filter (where ${subscriptions.status} = 'past_due')`,
      })
      .from(subscriptions)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, subscriptions.providerConnectionId),
      )
      .where(
        and(
          eq(subscriptions.applicationId, applicationId),
          eq(providerConnections.mode, environment),
        ),
      ),
    db
      .select({
        granted: sql<number>`coalesce(sum(${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('grant.purchase', 'grant.subscription', 'grant.promotion')), 0)`,
        debited: sql<number>`coalesce(sum(-${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('debit.usage', 'capture.usage')), 0)`,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationId, applicationId)),
    db
      .select({
        id: payments.id,
        status: payments.status,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        createdAt: payments.createdAt,
        provider: providerConnections.provider,
        customerEmail: applicationCustomers.email,
        externalCustomerId: applicationCustomers.externalCustomerId,
      })
      .from(payments)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, payments.providerConnectionId),
      )
      .leftJoin(
        applicationCustomers,
        eq(applicationCustomers.id, payments.customerId),
      )
      .where(eq(payments.applicationId, applicationId))
      .orderBy(desc(payments.createdAt))
      .limit(8),
    db
      .select({
        productId: products.id,
        productName: products.name,
        revenueMinor: sql<number>`sum(${orderItems.unitAmountMinor} * ${orderItems.quantity})`,
        units: sum(orderItems.quantity),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(
        and(eq(orders.applicationId, applicationId), eq(orders.status, "paid")),
      )
      .groupBy(products.id, products.name)
      .orderBy(
        desc(
          sql<number>`sum(${orderItems.unitAmountMinor} * ${orderItems.quantity})`,
        ),
      )
      .limit(5),
    db
      .select({ count: count() })
      .from(payments)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, payments.providerConnectionId),
      )
      .where(
        and(
          eq(payments.applicationId, applicationId),
          eq(payments.status, "failed"),
          eq(providerConnections.mode, environment),
          gte(payments.createdAt, sql`now() - interval '7 days'`),
        ),
      ),
    db
      .select({ count: count() })
      .from(subscriptions)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, subscriptions.providerConnectionId),
      )
      .where(
        and(
          eq(subscriptions.applicationId, applicationId),
          eq(subscriptions.status, "past_due"),
          eq(providerConnections.mode, environment),
        ),
      ),
    db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.applicationId, applicationId),
          eq(providerConnections.mode, environment),
          isNull(providerConnections.revokedAt),
        ),
      ),
  ]);

  const failedDeliveries = await db
    .select({ count: count() })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.applicationId, applicationId),
        eq(webhookDeliveries.status, "failed"),
        eq(webhookDeliveries.mode, environment),
      ),
    );

  const [developerHealth, productCountRows] = await Promise.all([
    getDeveloperHealth(applicationId, environment),
    db
      .select({ count: count() })
      .from(products)
      .where(eq(products.applicationId, applicationId)),
  ]);

  const providerHealth = providerRows.map((connection) => ({
    id: connection.id,
    provider: connection.provider,
    name: connection.name,
    status: connection.status,
    updatedAt: connection.updatedAt,
  }));

  const warnings: OverviewWarning[] = [];
  if (providerRows.length === 0) {
    warnings.push({
      level: "warning",
      message: `No ${environment === "test" ? "Sandbox" : "Production"} payment provider connected — checkout cannot run.`,
      href: "/providers",
    });
  }
  const failedPaymentCount = Number(failedRecentPayments[0]?.count ?? 0);
  if (failedPaymentCount > 0) {
    warnings.push({
      level: "danger",
      message: `${failedPaymentCount} failed payment${failedPaymentCount === 1 ? "" : "s"} in the last 7 days.`,
      href: "/payments",
    });
  }
  if (Number(pastDueSubscriptions[0]?.count ?? 0) > 0) {
    warnings.push({
      level: "warning",
      message: `${Number(pastDueSubscriptions[0].count)} subscription(s) past due.`,
      href: "/subscriptions",
    });
  }
  const failedDeliveryCount = Number(failedDeliveries[0]?.count ?? 0);
  if (failedDeliveryCount > 0) {
    warnings.push({
      level: "warning",
      message: `${failedDeliveryCount} failed webhook deliver${failedDeliveryCount === 1 ? "y" : "ies"} need attention.`,
      href: "/webhooks",
    });
  }

  const productCount = Number(productCountRows[0]?.count ?? 0);
  const setupSteps = [
    {
      key: "provider",
      label: "Connect a payment provider",
      href: "/providers",
      done: providerRows.length > 0,
    },
    {
      key: "product",
      label: "Create your first product",
      href: "/products",
      done: productCount > 0,
    },
    {
      key: "api-key",
      label: "Issue a server API key",
      href: "/api-keys",
      done: developerHealth.apiKeyCreated,
    },
    {
      key: "webhook",
      label: "Configure a webhook endpoint",
      href: "/webhooks",
      done: developerHealth.webhookConfigured,
    },
    {
      key: "sdk",
      label: "Make the first SDK request",
      href: "/developer",
      done: developerHealth.apiRequestReceived,
    },
    {
      key: "event",
      label: "Receive the first provider event",
      href: "/events",
      done: developerHealth.firstProviderEventReceived,
    },
    {
      key: "payment",
      label: "Receive the first payment",
      href: "/payments",
      done: developerHealth.firstPaymentReceived,
    },
  ];

  return {
    environment,
    kpis: {
      revenueMinor: Number(succeededPaymentStats[0]?.total ?? 0),
      payments: Number(succeededPaymentStats[0]?.paymentCount ?? 0),
      activeSubscriptions: Number(subscriptionStats[0]?.active ?? 0),
      creditsGranted: Number(creditStats[0]?.granted ?? 0),
      creditsDebited: Number(creditStats[0]?.debited ?? 0),
    },
    recentPayments,
    topProducts: topProducts.map((row) => ({
      productId: row.productId,
      productName: row.productName,
      revenueMinor: Number(row.revenueMinor ?? 0),
      units: Number(row.units ?? 0),
    })),
    providerHealth,
    warnings,
    setupSteps,
    developerHealth,
  };
}

export async function getRevenueAnalytics(
  applicationId: string,
  environment: ConsoleEnvironment,
) {
  const db = getDb();

  const since = monthStart(monthsBack(12)[0]);

  const monthlyRows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${payments.createdAt}), 'YYYY-MM')`,
      total: sum(payments.amountMinor),
      paymentCount: count(),
    })
    .from(payments)
    .innerJoin(
      providerConnections,
      eq(providerConnections.id, payments.providerConnectionId),
    )
    .where(
      and(
        eq(payments.applicationId, applicationId),
        eq(payments.status, "succeeded"),
        eq(providerConnections.mode, environment),
        gte(payments.createdAt, since),
      ),
    )
    .groupBy(sql`date_trunc('month', ${payments.createdAt})`)
    .orderBy(sql`date_trunc('month', ${payments.createdAt})`);

  const byMonth = new Map(
    monthlyRows.map((row) => [
      row.month,
      {
        revenueMinor: Number(row.total ?? 0),
        payments: Number(row.paymentCount ?? 0),
      },
    ]),
  );

  const monthly = monthsBack(12).map((month) => {
    const key = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    const entry = byMonth.get(key) ?? { revenueMinor: 0, payments: 0 };
    return { month: key, ...entry };
  });

  const productRows = await db
    .select({
      productId: products.id,
      productName: products.name,
      revenueMinor: sql<number>`sum(${orderItems.unitAmountMinor} * ${orderItems.quantity})`,
      units: sum(orderItems.quantity),
      orderCount: count(),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(
      and(eq(orders.applicationId, applicationId), eq(orders.status, "paid")),
    )
    .groupBy(products.id, products.name)
    .orderBy(
      desc(
        sql<number>`sum(${orderItems.unitAmountMinor} * ${orderItems.quantity})`,
      ),
    );

  const totalRevenueMinor = monthly.reduce(
    (total, entry) => total + entry.revenueMinor,
    0,
  );
  const totalPayments = monthly.reduce(
    (total, entry) => total + entry.payments,
    0,
  );

  return {
    monthly,
    byProduct: productRows.map((row) => ({
      productId: row.productId,
      productName: row.productName,
      revenueMinor: Number(row.revenueMinor ?? 0),
      units: Number(row.units ?? 0),
      orders: Number(row.orderCount ?? 0),
    })),
    totals: {
      revenueMinor: totalRevenueMinor,
      payments: totalPayments,
      averagePaymentMinor:
        totalPayments > 0 ? Math.round(totalRevenueMinor / totalPayments) : 0,
    },
  };
}

export async function getUsageAnalytics(applicationId: string) {
  const db = getDb();

  const since = monthStart(monthsBack(12)[0]);

  const [byCreditType, monthlyDebits, topCustomers] = await Promise.all([
    db
      .select({
        creditType: sql<string>`account.credit_type`,
        granted: sql<number>`coalesce(sum(${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('grant.purchase', 'grant.subscription', 'grant.promotion')), 0)`,
        debited: sql<number>`coalesce(sum(-${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('debit.usage', 'capture.usage')), 0)`,
        transactionCount: count(),
      })
      .from(creditTransactions)
      .innerJoin(
        sql`credit_accounts account`,
        sql`account.id = ${creditTransactions.creditAccountId}`,
      )
      .where(eq(creditTransactions.applicationId, applicationId))
      .groupBy(sql`account.credit_type`)
      .orderBy(
        desc(
          sql`coalesce(sum(-${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('debit.usage', 'capture.usage')), 0)`,
        ),
      ),
    db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${creditTransactions.createdAt}), 'YYYY-MM')`,
        debited: sql<number>`coalesce(sum(-${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('debit.usage', 'capture.usage')), 0)`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.applicationId, applicationId),
          gte(creditTransactions.createdAt, since),
        ),
      )
      .groupBy(sql`date_trunc('month', ${creditTransactions.createdAt})`),
    db
      .select({
        applicationCustomerId: applicationCustomers.id,
        externalCustomerId: applicationCustomers.externalCustomerId,
        email: applicationCustomers.email,
        debited: sql<number>`coalesce(sum(-${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('debit.usage', 'capture.usage')), 0)`,
        transactionCount: count(),
      })
      .from(creditTransactions)
      .innerJoin(
        applicationCustomers,
        eq(applicationCustomers.id, creditTransactions.applicationCustomerId),
      )
      .where(eq(creditTransactions.applicationId, applicationId))
      .groupBy(
        applicationCustomers.id,
        applicationCustomers.externalCustomerId,
        applicationCustomers.email,
      )
      .orderBy(
        desc(
          sql`coalesce(sum(-${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('debit.usage', 'capture.usage')), 0)`,
        ),
      )
      .limit(8),
  ]);

  const byMonth = new Map(
    monthlyDebits.map((row) => [row.month, Number(row.debited ?? 0)]),
  );
  const monthly = monthsBack(12).map((month) => {
    const key = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    return { month: key, debited: byMonth.get(key) ?? 0 };
  });

  return {
    monthly,
    byCreditType: byCreditType.map((row) => ({
      creditType: row.creditType,
      granted: Number(row.granted ?? 0),
      debited: Number(row.debited ?? 0),
      transactions: Number(row.transactionCount ?? 0),
    })),
    topCustomers: topCustomers.map((row) => ({
      applicationCustomerId: row.applicationCustomerId,
      externalCustomerId: row.externalCustomerId,
      email: row.email,
      debited: Number(row.debited ?? 0),
      transactions: Number(row.transactionCount ?? 0),
    })),
  };
}
