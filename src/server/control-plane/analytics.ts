import { and, count, desc, eq, gte, lt, sql, sum } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { products } from "@/modules/catalog/schema";
import {
  orderItems,
  orders,
  payments,
  subscriptionItems,
  subscriptions,
} from "@/modules/commerce/schema";
import { creditTransactions } from "@/modules/credits/schema";
import { applicationCustomers } from "@/modules/customers/schema";
import { billingOperations } from "@/modules/operations/schema";
import { providerConnections } from "@/modules/providers/schema";
import { usageEvents, usageMeters } from "@/modules/usage/schema";
import { webhookDeliveries } from "@/modules/webhooks/schema";
import type { ConsoleEnvironment } from "./context";

/**
 * Operational analytics v1 (#67) and the consolidated dashboard trend
 * views (audit A3).
 *
 * Metric definitions are documented in docs/analytics-definitions.md and
 * mirrored by the integration fixtures in
 * tests/integration/analytics-v1.test.ts and
 * tests/integration/overview-analytics.test.ts.
 *
 * Currency policy: amounts are NEVER summed across currencies. Every
 * revenue/MRR aggregate is grouped by currency; the UI renders one entry
 * per currency and labels mixed-currency views explicitly.
 *
 * Environment policy (audit A3): fact-table aggregates (payments, orders,
 * subscriptions, credit transactions) are scoped by their own
 * denormalized `environment` column — the historically-accurate record of
 * where the money moved. A provider connection's `mode` may change after
 * the fact and is therefore only used for current connection state, never
 * as an analytics filter. Integration tests pin this with payments whose
 * `payments.environment` disagrees with their connection mode.
 */

export type AnalyticsRange = { from: Date; to: Date };

export type CurrencyAmount = { currency: string; amountMinor: number };

export async function getRevenueAnalyticsV1(
  applicationId: string,
  environment: ConsoleEnvironment,
  range: AnalyticsRange,
  db: Database = getDb(),
) {
  const [volume, byProduct, byProvider, outcomes] = await Promise.all([
    db
      .select({
        currency: payments.currency,
        amountMinor: sum(payments.amountMinor),
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
          eq(payments.environment, environment),
          gte(payments.createdAt, range.from),
          lt(payments.createdAt, range.to),
        ),
      )
      .groupBy(payments.currency),
    db
      .select({
        currency: orders.currency,
        productName: sql<string>`p.name`,
        amountMinor: sum(orderItems.unitAmountMinor),
        units: sum(orderItems.quantity),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(sql`products p`, sql`p.id = ${orderItems.productId}`)
      .where(
        and(
          eq(orders.applicationId, applicationId),
          eq(orders.status, "paid"),
          eq(orders.environment, environment),
          gte(orders.createdAt, range.from),
          lt(orders.createdAt, range.to),
        ),
      )
      .groupBy(orders.currency, sql`p.name`),
    db
      .select({
        provider: providerConnections.provider,
        currency: payments.currency,
        amountMinor: sum(payments.amountMinor),
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
          eq(payments.environment, environment),
          gte(payments.createdAt, range.from),
          lt(payments.createdAt, range.to),
        ),
      )
      .groupBy(providerConnections.provider, payments.currency),
    db
      .select({
        status: payments.status,
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
          eq(payments.environment, environment),
          gte(payments.createdAt, range.from),
          lt(payments.createdAt, range.to),
        ),
      )
      .groupBy(payments.status),
  ]);

  const statusCounts = Object.fromEntries(
    outcomes.map((row) => [row.status, Number(row.paymentCount ?? 0)]),
  );
  const succeeded = statusCounts.succeeded ?? 0;
  const failed = statusCounts.failed ?? 0;
  const attempted = succeeded + failed;

  return {
    volumeByCurrency: volume.map((row) => ({
      currency: row.currency,
      amountMinor: Number(row.amountMinor ?? 0),
      payments: Number(row.paymentCount ?? 0),
    })),
    byProduct: byProduct.map((row) => ({
      currency: row.currency,
      productName: row.productName,
      amountMinor: Number(row.amountMinor ?? 0),
      units: Number(row.units ?? 0),
    })),
    byProvider: byProvider.map((row) => ({
      provider: row.provider,
      currency: row.currency,
      amountMinor: Number(row.amountMinor ?? 0),
      payments: Number(row.paymentCount ?? 0),
    })),
    paymentOutcomes: {
      succeeded,
      failed,
      refunded: statusCounts.refunded ?? 0,
      // Success rate = succeeded / (succeeded + failed); refunds and
      // pending attempts are excluded from the denominator (documented).
      successRate: attempted === 0 ? null : succeeded / attempted,
    },
  };
}

/**
 * MRR rule (documented): for each ACTIVE subscription, take each item's
 * snapshot terms and normalize the recurring amount to one month:
 *   week  -> amount * 52 / 12
 *   month -> amount
 *   year  -> amount / 12
 * Normalized values are rounded to integer minor units and grouped by
 * currency — never summed across currencies.
 */
export async function getSubscriptionAnalytics(
  applicationId: string,
  environment: ConsoleEnvironment,
  db: Database = getDb(),
) {
  const [statusRows, itemRows] = await Promise.all([
    db
      .select({ status: subscriptions.status, count: count() })
      .from(subscriptions)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, subscriptions.providerConnectionId),
      )
      .where(
        and(
          eq(subscriptions.applicationId, applicationId),
          eq(subscriptions.environment, environment),
        ),
      )
      .groupBy(subscriptions.status),
    db
      .select({
        currency: subscriptionItems.currency,
        interval: subscriptionItems.recurringInterval,
        normalized: sql<number>`sum(
          CASE ${subscriptionItems.recurringInterval}
            WHEN 'week' THEN ${subscriptionItems.unitAmountMinor} * 52.0 / 12.0
            WHEN 'year' THEN ${subscriptionItems.unitAmountMinor} / 12.0
            ELSE ${subscriptionItems.unitAmountMinor} * 1.0
          END * ${subscriptionItems.quantity}
        )`,
      })
      .from(subscriptionItems)
      .innerJoin(
        subscriptions,
        eq(subscriptions.id, subscriptionItems.subscriptionId),
      )
      .where(
        and(
          eq(subscriptions.applicationId, applicationId),
          eq(subscriptions.environment, environment),
          eq(subscriptions.status, "active"),
        ),
      )
      .groupBy(subscriptionItems.currency, subscriptionItems.recurringInterval),
  ]);

  const statusCounts = Object.fromEntries(
    statusRows.map((row) => [row.status, Number(row.count ?? 0)]),
  );
  // Rows may be split per interval; merge to one normalized entry per currency.
  const mrrByCurrencyMap = new Map<string, number>();
  for (const row of itemRows) {
    mrrByCurrencyMap.set(
      row.currency,
      (mrrByCurrencyMap.get(row.currency) ?? 0) + Number(row.normalized ?? 0),
    );
  }
  return {
    statusCounts,
    active: statusCounts.active ?? 0,
    pastDue: statusCounts.past_due ?? 0,
    mrrByCurrency: [...mrrByCurrencyMap.entries()].map(([currency, total]) => ({
      currency,
      amountMinor: Math.round(total),
    })),
  };
}

/** Provider health from OBSERVED MonetPlane runtime operations only. */
export async function getProviderHealthAnalytics(
  applicationId: string,
  environment: ConsoleEnvironment,
  db: Database = getDb(),
) {
  const [operationRows, deliveryRows] = await Promise.all([
    db
      .select({
        provider: providerConnections.provider,
        status: billingOperations.status,
        failureKind: billingOperations.failureKind,
        avgDurationMs: sql<number>`avg(
          extract(epoch from (${billingOperations.completedAt} - ${billingOperations.createdAt})) * 1000
        )`,
        count: count(),
      })
      .from(billingOperations)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, billingOperations.providerConnectionId),
      )
      .where(
        and(
          eq(billingOperations.applicationId, applicationId),
          eq(billingOperations.environment, environment),
        ),
      )
      .groupBy(
        providerConnections.provider,
        billingOperations.status,
        billingOperations.failureKind,
      ),
    db
      .select({
        status: webhookDeliveries.status,
        count: count(),
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.applicationId, applicationId),
          eq(webhookDeliveries.mode, environment),
        ),
      )
      .groupBy(webhookDeliveries.status),
  ]);

  const providerMap = new Map<
    string,
    {
      provider: string;
      operations: number;
      failedOperations: number;
      uncertainOperations: number;
      rejectedByProvider: number;
      avgDurationMs: number | null;
    }
  >();
  for (const row of operationRows) {
    const entry = providerMap.get(row.provider) ?? {
      provider: row.provider,
      operations: 0,
      failedOperations: 0,
      uncertainOperations: 0,
      rejectedByProvider: 0,
      avgDurationMs: null,
    };
    entry.operations += Number(row.count ?? 0);
    if (row.status === "failed" || row.status === "needs_reconciliation") {
      entry.failedOperations += Number(row.count ?? 0);
      if (row.failureKind === "outcome_uncertain") {
        entry.uncertainOperations += Number(row.count ?? 0);
      } else if (row.failureKind === "rejected") {
        entry.rejectedByProvider += Number(row.count ?? 0);
      }
    }
    const duration = Number(row.avgDurationMs ?? 0);
    if (duration > 0) entry.avgDurationMs = duration;
    providerMap.set(row.provider, entry);
  }

  const deliveryCounts = Object.fromEntries(
    deliveryRows.map((row) => [row.status, Number(row.count ?? 0)]),
  );
  return {
    providers: [...providerMap.values()],
    webhookDeliveries: {
      succeeded: deliveryCounts.succeeded ?? 0,
      failed: deliveryCounts.failed ?? 0,
      pending: deliveryCounts.pending ?? 0,
    },
  };
}

/** Usage trends per meter plus top consumers for the period. */
export async function getUsageTrends(
  applicationId: string,
  environment: ConsoleEnvironment,
  range: AnalyticsRange,
  db: Database = getDb(),
) {
  const [byMeter, topConsumers] = await Promise.all([
    db
      .select({
        meterKey: usageMeters.key,
        unit: usageMeters.unit,
        measured: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)`,
        events: count(),
      })
      .from(usageMeters)
      .leftJoin(
        usageEvents,
        and(
          eq(usageEvents.meterId, usageMeters.id),
          eq(usageEvents.environment, environment),
          gte(usageEvents.occurredAt, range.from),
          lt(usageEvents.occurredAt, range.to),
        ),
      )
      .where(eq(usageMeters.applicationId, applicationId))
      .groupBy(usageMeters.key, usageMeters.unit),
    db
      .select({
        externalCustomerId: sql<string>`ac.external_customer_id`,
        measured: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)`,
        events: count(),
      })
      .from(usageEvents)
      .innerJoin(
        sql`application_customers ac`,
        sql`ac.id = ${usageEvents.applicationCustomerId}`,
      )
      .where(
        and(
          eq(usageEvents.applicationId, applicationId),
          eq(usageEvents.environment, environment),
          gte(usageEvents.occurredAt, range.from),
          lt(usageEvents.occurredAt, range.to),
        ),
      )
      .groupBy(sql`ac.external_customer_id`)
      .orderBy(desc(sql`coalesce(sum(${usageEvents.quantity}), 0)`))
      .limit(10),
  ]);

  return {
    byMeter: byMeter.map((row) => ({
      meterKey: row.meterKey,
      unit: row.unit,
      measuredQuantity: Number(row.measured ?? 0),
      events: Number(row.events ?? 0),
    })),
    topConsumers: topConsumers.map((row) => ({
      externalCustomerId: row.externalCustomerId,
      measuredQuantity: Number(row.measured ?? 0),
      events: Number(row.events ?? 0),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Dashboard trend views (audit A3 — consolidated from overview.ts)    */
/* ------------------------------------------------------------------ */

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

/**
 * 12-month revenue trend for the Revenue page (audit A3 consolidation of
 * the former overview.getRevenueAnalytics).
 *
 * Environment: `payments.environment` (canonical — see the module header),
 * superseding the former `providerConnections.mode` filter.
 *
 * Currency: monthly buckets, product breakdown, and totals are all grouped
 * by currency; nothing is ever summed across currencies. `monthly` is
 * zero-filled per observed currency so each currency renders a full
 * 12-month series; `totals.byCurrency` is sorted by revenue (dominant
 * currency first) so KPI cards can lead with it and label the chart.
 */
export async function getRevenueAnalytics(
  applicationId: string,
  environment: ConsoleEnvironment,
  db: Database = getDb(),
) {
  const since = monthStart(monthsBack(12)[0]);

  const monthlyRows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${payments.createdAt}), 'YYYY-MM')`,
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
        gte(payments.createdAt, since),
      ),
    )
    .groupBy(sql`date_trunc('month', ${payments.createdAt})`, payments.currency)
    .orderBy(sql`date_trunc('month', ${payments.createdAt})`);

  const byMonthCurrency = new Map<
    string,
    { revenueMinor: number; payments: number }
  >();
  for (const row of monthlyRows) {
    byMonthCurrency.set(`${row.month}|${row.currency}`, {
      revenueMinor: Number(row.total ?? 0),
      payments: Number(row.paymentCount ?? 0),
    });
  }
  const currencies = [
    ...new Set(monthlyRows.map((row) => row.currency)),
  ].sort();
  const monthKeys = monthsBack(12).map(
    (month) =>
      `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`,
  );
  const monthly = currencies.flatMap((currency) =>
    monthKeys.map((month) => {
      const entry =
        byMonthCurrency.get(`${month}|${currency}`) ??
        ({ revenueMinor: 0, payments: 0 } as const);
      return { month, currency, ...entry };
    }),
  );

  // Product breakdown grouped by (product, currency) — a product sold in
  // two currencies yields two rows instead of a meaningless cross-currency
  // sum (audit A3).
  const productRows = await db
    .select({
      productId: products.id,
      productName: products.name,
      currency: orders.currency,
      revenueMinor: sql<number>`sum(${orderItems.unitAmountMinor} * ${orderItems.quantity})`,
      units: sum(orderItems.quantity),
      orderCount: count(),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(
      and(
        eq(orders.applicationId, applicationId),
        eq(orders.status, "paid"),
        eq(orders.environment, environment),
      ),
    )
    .groupBy(products.id, products.name, orders.currency)
    .orderBy(
      desc(
        sql<number>`sum(${orderItems.unitAmountMinor} * ${orderItems.quantity})`,
      ),
      orders.currency,
    );

  const byCurrency = currencies
    .map((currency) => {
      const rows = monthly.filter((entry) => entry.currency === currency);
      const revenueMinor = rows.reduce(
        (total, entry) => total + entry.revenueMinor,
        0,
      );
      const payments = rows.reduce((total, entry) => total + entry.payments, 0);
      return {
        currency,
        revenueMinor,
        payments,
        averagePaymentMinor:
          payments > 0 ? Math.round(revenueMinor / payments) : 0,
      };
    })
    .sort((a, b) => b.revenueMinor - a.revenueMinor);

  return {
    monthly,
    byProduct: productRows.map((row) => ({
      productId: row.productId,
      productName: row.productName,
      currency: row.currency,
      revenueMinor: Number(row.revenueMinor ?? 0),
      units: Number(row.units ?? 0),
      orders: Number(row.orderCount ?? 0),
    })),
    totals: {
      // Payment counts are currency-independent; amounts never are.
      payments: byCurrency.reduce((total, entry) => total + entry.payments, 0),
      byCurrency,
    },
  };
}

/**
 * Credit consumption analytics for the Usage page (audit A3 consolidation
 * of the former overview.getUsageAnalytics).
 *
 * NOTE: this is a DIFFERENT metric from getUsageTrends above — credit
 * ledger debits/grants (credit_transactions) vs metered usage events
 * (usage_events). They were never duplicates; they now simply live in the
 * one read service. Credit scoping uses the ledger's own environment
 * column (canonical), as before.
 */
export async function getUsageAnalytics(
  applicationId: string,
  environment: ConsoleEnvironment = "test",
  db: Database = getDb(),
) {
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
      .where(
        and(
          eq(creditTransactions.applicationId, applicationId),
          eq(creditTransactions.environment, environment),
        ),
      )
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
          eq(creditTransactions.environment, environment),
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
      .where(
        and(
          eq(creditTransactions.applicationId, applicationId),
          eq(creditTransactions.environment, environment),
        ),
      )
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
