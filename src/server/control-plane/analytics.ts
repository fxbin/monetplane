import { and, count, desc, eq, gte, isNull, lt, sql, sum } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import {
  orderItems,
  orders,
  payments,
  subscriptionItems,
  subscriptions,
} from "@/modules/commerce/schema";
import { billingOperations } from "@/modules/operations/schema";
import { providerConnections } from "@/modules/providers/schema";
import { usageEvents, usageMeters } from "@/modules/usage/schema";
import { webhookDeliveries } from "@/modules/webhooks/schema";
import type { ConsoleEnvironment } from "./context";

/**
 * Operational analytics v1 (#67).
 *
 * Metric definitions are documented in docs/analytics-definitions.md and
 * mirrored by the integration fixtures in
 * tests/integration/analytics-v1.test.ts.
 *
 * Currency policy: amounts are NEVER summed across currencies. Every
 * revenue/MRR aggregate is grouped by currency; the UI renders one entry
 * per currency and labels mixed-currency views explicitly.
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
