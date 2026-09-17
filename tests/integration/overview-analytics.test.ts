import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import {
  orderItems,
  orders,
  payments,
  subscriptions,
} from "../../src/modules/commerce/schema";
import { debitCredits, grantCredits } from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { createProviderConnection } from "../../src/modules/providers/service";
import {
  getOverviewCommandCenter,
  getRevenueAnalytics,
  getUsageAnalytics,
} from "../../src/server/control-plane/overview";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  await getSqlClient().end({ timeout: 1 });
});

type Seed = Awaited<ReturnType<typeof seedBillingFixture>>;

async function seedBillingFixture() {
  const slug = `overview-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  const customer = await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      email: "overview@test",
    },
    db,
  );
  const product = await createProduct(
    { applicationId: app.id, key: "pro", name: "Pro Plan" },
    db,
  );
  const price = await createPrice(
    {
      applicationId: app.id,
      productId: product.id,
      key: "one-time",
      currency: "USD",
      amountMinor: 2500,
      billingType: "one_time",
    },
    db,
  );
  const providerConnection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "primary",
      mode: "test",
      credentials: { webhookSecret: "overview-secret" },
    },
    db,
  );

  const [order] = await db
    .insert(orders)
    .values({
      id: `order_${randomUUID()}`,
      applicationId: app.id,
      applicationCustomerId: customer.id,
      billingMode: "one_time",
      status: "paid",
      currency: "USD",
      totalAmountMinor: 5000,
    })
    .returning();
  await db.insert(orderItems).values({
    id: `oi_${randomUUID()}`,
    orderId: order.id,
    productId: product.id,
    priceId: price.id,
    quantity: 2,
    unitAmountMinor: 2500,
  });
  await db.insert(payments).values({
    id: `pay_${randomUUID()}`,
    applicationId: app.id,
    orderId: order.id,
    customerId: customer.customerId,
    providerConnectionId: providerConnection.id,
    providerPaymentId: `pp_${randomUUID()}`,
    status: "succeeded",
    amountMinor: 5000,
    currency: "USD",
  });
  await db.insert(subscriptions).values({
    id: `sub_${randomUUID()}`,
    applicationId: app.id,
    applicationCustomerId: customer.id,
    providerConnectionId: providerConnection.id,
    providerSubscriptionId: `ps_${randomUUID()}`,
    status: "active",
  });

  await grantCredits(
    {
      applicationId: app.id,
      applicationCustomerId: customer.id,
      creditType: "agent.run",
      amount: 1000,
      transactionType: "grant.promotion",
      sourceType: "test",
      sourceId: "seed",
      idempotencyKey: `grant-${slug}`,
    },
    db,
  );
  await debitCredits(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      creditType: "agent.run",
      amount: 300,
      sourceType: "usage",
      sourceId: "job-1",
      idempotencyKey: `debit-${slug}`,
    },
    db,
  );

  return { app, customer, product, order, providerConnection };
}

describe("overview command center analytics", () => {
  it("reports empty state and a full setup checklist for a fresh application", async () => {
    const slug = `empty-${Math.random().toString(36).slice(2, 8)}`;
    const app = await createApplication({ slug, name: slug }, db);

    const overview = await getOverviewCommandCenter(app.id, "test");

    expect(overview.kpis).toEqual({
      revenueMinor: 0,
      payments: 0,
      activeSubscriptions: 0,
      creditsGranted: 0,
      creditsDebited: 0,
    });
    expect(overview.topProducts).toHaveLength(0);
    expect(overview.recentPayments).toHaveLength(0);
    expect(overview.setupSteps.map((step) => step.done)).toEqual(
      Array(7).fill(false),
    );
    // The most prominent warning for a fresh project is the missing provider.
    expect(overview.warnings[0]).toMatchObject({
      level: "warning",
      href: "/providers",
    });

    const revenue = await getRevenueAnalytics(app.id, "test");
    expect(revenue.totals).toEqual({
      revenueMinor: 0,
      payments: 0,
      averagePaymentMinor: 0,
    });
    expect(revenue.monthly).toHaveLength(12);

    const usage = await getUsageAnalytics(app.id);
    expect(usage.byCreditType).toHaveLength(0);
    expect(usage.topCustomers).toHaveLength(0);
  });

  it("aggregates KPIs, checklist progress, top products, and revenue from real data", async () => {
    const seed: Seed = await seedBillingFixture();

    const overview = await getOverviewCommandCenter(seed.app.id, "test");

    expect(overview.kpis.revenueMinor).toBe(5000);
    expect(overview.kpis.payments).toBe(1);
    expect(overview.kpis.activeSubscriptions).toBe(1);
    expect(overview.kpis.creditsGranted).toBe(1000);
    expect(overview.kpis.creditsDebited).toBe(300);

    expect(overview.topProducts).toHaveLength(1);
    expect(overview.topProducts[0]).toMatchObject({
      productName: "Pro Plan",
      revenueMinor: 5000,
      units: 2,
    });

    expect(overview.recentPayments).toHaveLength(1);
    expect(overview.recentPayments[0]).toMatchObject({
      status: "succeeded",
      provider: "mock",
    });

    // Provider connected and product created, but developer integration
    // steps (API key, webhook, SDK, event, payment) are still pending.
    const stepStates = Object.fromEntries(
      overview.setupSteps.map((step) => [step.key, step.done]),
    );
    expect(stepStates).toEqual({
      provider: true,
      product: true,
      "api-key": false,
      webhook: false,
      sdk: false,
      event: false,
      // A succeeded payment exists from the seed, so the first-payment
      // milestone is already observed.
      payment: true,
    });

    // No operational warnings for a healthy fixture.
    expect(overview.warnings).toHaveLength(0);

    const revenue = await getRevenueAnalytics(seed.app.id, "test");
    expect(revenue.totals.revenueMinor).toBe(5000);
    expect(revenue.totals.payments).toBe(1);
    expect(revenue.totals.averagePaymentMinor).toBe(5000);
    const currentMonth = revenue.monthly.at(-1);
    expect(currentMonth).toMatchObject({ revenueMinor: 5000, payments: 1 });
    expect(revenue.byProduct[0]).toMatchObject({
      productName: "Pro Plan",
      revenueMinor: 5000,
      units: 2,
      orders: 1,
    });

    const usage = await getUsageAnalytics(seed.app.id);
    expect(usage.byCreditType).toHaveLength(1);
    expect(usage.byCreditType[0]).toMatchObject({
      creditType: "agent.run",
      granted: 1000,
      debited: 300,
    });
    expect(usage.topCustomers).toHaveLength(1);
    expect(usage.topCustomers[0]).toMatchObject({
      externalCustomerId: "user-1",
      debited: 300,
    });
    expect(usage.monthly.at(-1)?.debited).toBe(300);
  });

  it("scopes KPIs to the selected environment via provider connection mode", async () => {
    const seed: Seed = await seedBillingFixture();

    const live = await getOverviewCommandCenter(seed.app.id, "live");
    expect(live.kpis.revenueMinor).toBe(0);
    expect(live.kpis.payments).toBe(0);
    expect(live.kpis.activeSubscriptions).toBe(0);
    // Live has no provider connected -> missing-provider warning appears.
    expect(live.warnings).toHaveLength(1);

    const test = await getOverviewCommandCenter(seed.app.id, "test");
    expect(test.kpis.payments).toBe(1);
  });

  it("surfaces failed payments as a danger warning", async () => {
    const seed: Seed = await seedBillingFixture();
    await db.insert(payments).values({
      id: `pay_${randomUUID()}`,
      applicationId: seed.app.id,
      providerConnectionId: seed.providerConnection.id,
      providerPaymentId: `pp_${randomUUID()}`,
      status: "failed",
      amountMinor: 100,
      currency: "USD",
    });

    const overview = await getOverviewCommandCenter(seed.app.id, "test");
    expect(
      overview.warnings.some(
        (warning) =>
          warning.level === "danger" &&
          warning.message.includes("failed payment"),
      ),
    ).toBe(true);
  });
});
