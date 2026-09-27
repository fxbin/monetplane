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
 * Read-only queries that back the Overview page. The Revenue / Usage
 * trend views live in ./analytics (audit A3 consolidation) — this module
 * owns only the command-center snapshot.
 *
 * Environment semantics (audit A3): money and subscription aggregates are
 * scoped by the fact table's own denormalized `environment` column — the
 * historically-accurate record of where the money moved (a connection's
 * mode can be edited after the fact; see ./analytics for the canonical
 * rule pinned by tests). `providerConnections.mode` is used only for
 * CURRENT connection state (provider health, setup warnings). Credits are
 * project-wide today and are labeled as such in the UI.
 */

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
        currency: payments.currency,
        total: sum(payments.amountMinor),
        paymentCount: count(),
      })
      .from(payments)
      .where(
        and(
          eq(payments.applicationId, applicationId),
          eq(payments.status, "succeeded"),
          eq(payments.environment, environment),
        ),
      )
      .groupBy(payments.currency),
    db
      .select({
        active: sql<number>`count(*) filter (where ${subscriptions.status} = 'active')`,
        pastDue: sql<number>`count(*) filter (where ${subscriptions.status} = 'past_due')`,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.applicationId, applicationId),
          eq(subscriptions.environment, environment),
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
        currency: orders.currency,
        revenueMinor: sql<number>`sum(${orderItems.unitAmountMinor} * ${orderItems.quantity})`,
        units: sum(orderItems.quantity),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(
        and(eq(orders.applicationId, applicationId), eq(orders.status, "paid")),
      )
      .groupBy(products.id, products.name, orders.currency)
      .orderBy(
        desc(
          sql<number>`sum(${orderItems.unitAmountMinor} * ${orderItems.quantity})`,
        ),
        orders.currency,
      )
      .limit(5),
    db
      .select({ count: count() })
      .from(payments)
      .where(
        and(
          eq(payments.applicationId, applicationId),
          eq(payments.status, "failed"),
          eq(payments.environment, environment),
          gte(payments.createdAt, sql`now() - interval '7 days'`),
        ),
      ),
    db
      .select({ count: count() })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.applicationId, applicationId),
          eq(subscriptions.status, "past_due"),
          eq(subscriptions.environment, environment),
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
      // Per-currency revenue: amounts are never summed across currencies;
      // the UI renders one entry per currency (dominant first).
      revenueByCurrency: succeededPaymentStats
        .map((row) => ({
          currency: row.currency,
          amountMinor: Number(row.total ?? 0),
        }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      payments: Number(
        succeededPaymentStats.reduce(
          (total, row) => total + Number(row.paymentCount ?? 0),
          0,
        ),
      ),
      activeSubscriptions: Number(subscriptionStats[0]?.active ?? 0),
      creditsGranted: Number(creditStats[0]?.granted ?? 0),
      creditsDebited: Number(creditStats[0]?.debited ?? 0),
    },
    recentPayments,
    topProducts: topProducts.map((row) => ({
      productId: row.productId,
      productName: row.productName,
      currency: row.currency,
      revenueMinor: Number(row.revenueMinor ?? 0),
      units: Number(row.units ?? 0),
    })),
    providerHealth,
    warnings,
    setupSteps,
    developerHealth,
  };
}
