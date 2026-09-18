import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import {
  orders,
  payments,
  subscriptionItems,
  subscriptions,
} from "../../src/modules/commerce/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { billingOperations } from "../../src/modules/operations/schema";
import { createProviderConnection } from "../../src/modules/providers/service";
import { createUsageMeter, reportUsage } from "../../src/modules/usage/service";
import { webhookDeliveries } from "../../src/modules/webhooks/schema";
import {
  getProviderHealthAnalytics,
  getRevenueAnalyticsV1,
  getSubscriptionAnalytics,
  getUsageTrends,
} from "../../src/server/control-plane/analytics";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  await getSqlClient().end({ timeout: 1 });
});

const eqApp = (applicationId: string) =>
  eq(subscriptions.applicationId, applicationId);
const eqSub = (id: string) => eq(subscriptions.id, id);

function range(): { from: Date; to: Date } {
  const now = new Date();
  return {
    from: new Date(now.getTime() - 30 * 24 * 3600 * 1000),
    to: new Date(now.getTime() + 60_000),
  };
}

async function seedWithMixedCurrencyPayments() {
  const slug = `analytics-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1", email: "a@test" },
    db,
  );
  const product = await createProduct(
    { applicationId: app.id, key: "pro", name: "Pro" },
    db,
  );
  const connection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "primary",
      mode: "test",
      credentials: { webhookSecret: `${slug}-secret` },
    },
    db,
  );
  const order = await db
    .insert(orders)
    .values({
      id: `ord_${randomUUID()}`,
      applicationId: app.id,
      applicationCustomerId: customer.id,
      billingMode: "one_time",
      status: "paid",
      currency: "USD",
      totalAmountMinor: 5000,
      environment: "test",
    })
    .returning();
  await db.insert(payments).values([
    {
      id: `pay_${randomUUID()}`,
      applicationId: app.id,
      orderId: order[0].id,
      providerConnectionId: connection.id,
      providerPaymentId: `pp_${randomUUID()}`,
      status: "succeeded",
      amountMinor: 5000,
      currency: "USD",
      environment: "test",
    },
    {
      id: `pay_${randomUUID()}`,
      applicationId: app.id,
      providerConnectionId: connection.id,
      providerPaymentId: `pp_${randomUUID()}`,
      status: "succeeded",
      amountMinor: 3000,
      currency: "EUR",
      environment: "test",
    },
    {
      id: `pay_${randomUUID()}`,
      applicationId: app.id,
      providerConnectionId: connection.id,
      providerPaymentId: `pp_${randomUUID()}`,
      status: "failed",
      amountMinor: 700,
      currency: "USD",
      environment: "test",
    },
  ]);
  return { app, customer, product, connection, orderId: order[0].id };
}

type Seed = Awaited<ReturnType<typeof seedWithMixedCurrencyPayments>>;

describe("analytics v1 (#67)", () => {
  it("separates mixed currencies instead of summing them, and computes success rate per definition", async () => {
    const seed: Seed = await seedWithMixedCurrencyPayments();
    const result = await getRevenueAnalyticsV1(
      seed.app.id,
      "test",
      range(),
      db,
    );

    const usd = result.volumeByCurrency.find((c) => c.currency === "USD");
    const eur = result.volumeByCurrency.find((c) => c.currency === "EUR");
    expect(usd).toMatchObject({ amountMinor: 5000, payments: 1 });
    expect(eur).toMatchObject({ amountMinor: 3000, payments: 1 });
    // 2 succeeded, 1 failed -> 2/3.
    expect(result.paymentOutcomes.successRate).toBeCloseTo(2 / 3, 5);
    expect(result.paymentOutcomes.refunded).toBe(0);

    // Live environment sees nothing.
    const live = await getRevenueAnalyticsV1(seed.app.id, "live", range(), db);
    expect(live.volumeByCurrency).toHaveLength(0);
    expect(live.paymentOutcomes.successRate).toBeNull();
  });

  it("computes MRR per currency with documented interval normalization", async () => {
    const seed: Seed = await seedWithMixedCurrencyPayments();
    const mk = async (
      interval: "week" | "month" | "year",
      amountMinor: number,
      key: string,
    ) => {
      const price = await createPrice(
        {
          applicationId: seed.app.id,
          productId: seed.product.id,
          key,
          currency: "USD",
          amountMinor,
          billingType: "recurring",
          recurringInterval: interval,
        },
        db,
      );
      const [subscription] = await db
        .insert(subscriptions)
        .values({
          id: `sub_${randomUUID()}`,
          applicationId: seed.app.id,
          applicationCustomerId: seed.customer.id,
          providerConnectionId: seed.connection.id,
          providerSubscriptionId: `ps_${randomUUID()}`,
          status: "active",
          environment: "test",
        })
        .returning();
      await db.insert(subscriptionItems).values({
        id: `subitem_${randomUUID()}`,
        subscriptionId: subscription.id,
        productId: seed.product.id,
        priceId: price.id,
        quantity: 1,
        unitAmountMinor: amountMinor,
        currency: "USD",
        recurringInterval: interval,
      });
    };
    await mk("month", 1200, "monthly"); // 1200
    await mk("year", 24000, "annual"); // 2000
    await mk("week", 690, "weekly"); // 690*52/12 = 2990
    await mk("month", 9900, "paused"); // not active below

    // Make the last subscription inactive so it drops out of MRR.
    const [rows] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eqApp(seed.app.id))
      .limit(50);
    void rows;
    // cancel all but first three by marking cancelled via direct update
    const all = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eqApp(seed.app.id));
    for (const row of all.slice(3)) {
      await db
        .update(subscriptions)
        .set({ status: "cancelled" })
        .where(eqSub(row.id));
    }

    const result = await getSubscriptionAnalytics(seed.app.id, "test", db);
    expect(result.active).toBe(3);
    const usd = result.mrrByCurrency.find((c) => c.currency === "USD");
    // 1200 + 2000 + round(690*52/12)
    expect(usd?.amountMinor).toBe(1200 + 2000 + Math.round((690 * 52) / 12));
  });

  it("classifies provider failures as rejected vs outcome-uncertain from observed operations", async () => {
    const seed: Seed = await seedWithMixedCurrencyPayments();
    await db.insert(billingOperations).values([
      {
        id: `bop_${randomUUID()}`,
        applicationId: seed.app.id,
        type: "refund",
        resourceType: "payment",
        resourceId: "pay_x",
        providerConnectionId: seed.connection.id,
        providerResourceId: "pp_x",
        idempotencyKey: `op-${randomUUID()}`,
        status: "provider_succeeded",
        environment: "test",
        createdAt: new Date(Date.now() - 2000),
        completedAt: new Date(Date.now() - 1000),
        normalizedResult: {},
      },
      {
        id: `bop_${randomUUID()}`,
        applicationId: seed.app.id,
        type: "refund",
        resourceType: "payment",
        resourceId: "pay_y",
        providerConnectionId: seed.connection.id,
        providerResourceId: "pp_y",
        idempotencyKey: `op-${randomUUID()}`,
        status: "failed",
        failureKind: "rejected",
        environment: "test",
        completedAt: new Date(),
        normalizedResult: {},
      },
      {
        id: `bop_${randomUUID()}`,
        applicationId: seed.app.id,
        type: "refund",
        resourceType: "payment",
        resourceId: "pay_z",
        providerConnectionId: seed.connection.id,
        providerResourceId: "pp_z",
        idempotencyKey: `op-${randomUUID()}`,
        status: "needs_reconciliation",
        failureKind: "outcome_uncertain",
        environment: "test",
        completedAt: new Date(),
        normalizedResult: {},
      },
    ]);
    const [endpoint] = await db
      .insert(
        (await import("../../src/modules/webhooks/schema")).webhookEndpoints,
      )
      .values({
        id: `whep_${randomUUID()}`,
        applicationId: seed.app.id,
        mode: "test",
        name: "analytics",
        url: "https://hooks.test/monetplane",
        secretCiphertext: "x",
        secretPrefix: "whsec_analytics",
        eventTypes: [],
      })
      .returning();
    await db.insert(webhookDeliveries).values([
      {
        id: `whd_${randomUUID()}`,
        endpointId: endpoint.id,
        applicationId: seed.app.id,
        mode: "test",
        eventId: `evt_${randomUUID()}`,
        eventType: "payment.succeeded",
        payload: {},
        status: "succeeded",
      },
      {
        id: `whd_${randomUUID()}`,
        endpointId: endpoint.id,
        applicationId: seed.app.id,
        mode: "test",
        eventId: `evt_${randomUUID()}`,
        eventType: "payment.succeeded",
        payload: {},
        status: "failed",
      },
    ]);

    const health = await getProviderHealthAnalytics(seed.app.id, "test", db);
    const mock = health.providers.find((p) => p.provider === "mock");
    expect(mock).toMatchObject({
      operations: 3,
      failedOperations: 2,
      uncertainOperations: 1,
      rejectedByProvider: 1,
    });
    expect(mock?.avgDurationMs).not.toBeNull();
    expect(health.webhookDeliveries).toEqual({
      succeeded: 1,
      failed: 1,
      pending: 0,
    });
  });

  it("aggregates usage by meter and ranks top consumers", async () => {
    const seed: Seed = await seedWithMixedCurrencyPayments();
    await createApplicationCustomer(
      {
        applicationId: seed.app.id,
        externalCustomerId: "user-2",
        email: "b@test",
      },
      db,
    );
    await createUsageMeter(
      {
        applicationId: seed.app.id,
        key: "agent.jobs",
        name: "Agent jobs",
        unit: "job",
        currency: "USD",
        billingScheme: "per_unit",
        perUnitAmountMinor: 1,
      },
      db,
    );
    for (const [customer, n] of [
      ["user-1", 5],
      ["user-2", 9],
    ] as const) {
      for (let i = 0; i < n; i += 1) {
        await reportUsage(
          {
            applicationId: seed.app.id,
            environment: "test",
            meterKey: "agent.jobs",
            externalCustomerId: customer,
            quantity: 1,
            sourceType: "app",
            sourceId: `s-${customer}-${i}`,
            idempotencyKey: `u-${customer}-${i}`,
          },
          db,
        );
      }
    }

    const trends = await getUsageTrends(seed.app.id, "test", range(), db);
    expect(trends.byMeter[0]).toMatchObject({
      meterKey: "agent.jobs",
      measuredQuantity: 14,
      events: 14,
    });
    expect(trends.topConsumers[0]).toMatchObject({
      externalCustomerId: "user-2",
      measuredQuantity: 9,
    });

    // Live sees no usage.
    const live = await getUsageTrends(seed.app.id, "live", range(), db);
    expect(live.topConsumers).toHaveLength(0);
  });

  it("returns useful empty states for a fresh application", async () => {
    const slug = `analytics-empty-${Math.random().toString(36).slice(2, 6)}`;
    const app = await createApplication({ slug, name: slug }, db);
    const r = range();
    const revenue = await getRevenueAnalyticsV1(app.id, "test", r, db);
    const subs = await getSubscriptionAnalytics(app.id, "test", db);
    const usage = await getUsageTrends(app.id, "test", r, db);
    expect(revenue.volumeByCurrency).toHaveLength(0);
    expect(revenue.paymentOutcomes.successRate).toBeNull();
    expect(subs.active).toBe(0);
    expect(subs.mrrByCurrency).toHaveLength(0);
    expect(usage.byMeter).toHaveLength(0);
    expect(usage.topConsumers).toHaveLength(0);
  });
});
