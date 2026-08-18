import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import {
  createApplication,
  registerCallbackOrigin,
} from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import { createCommerceCheckout } from "../../src/modules/commerce/checkout";
import {
  checkoutSessions,
  orders,
  payments,
  refunds,
  subscriptionItems,
  subscriptions,
  webhookEvents,
} from "../../src/modules/commerce/schema";
import { processProviderWebhook } from "../../src/modules/commerce/webhook";
import { customers } from "../../src/modules/customers/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
import { InvalidProviderWebhookSignatureError } from "../../src/modules/providers/contract";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(mode: "one_time" | "subscription" = "one_time") {
  const slug = `commerce-${mode}-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  await registerCallbackOrigin(app.id, "https://product.test/success", db);
  await registerCallbackOrigin(app.id, "https://product.test/cancel", db);

  const applicationCustomer = await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      email: "user@example.com",
    },
    db,
  );
  const product = await createProduct(
    { applicationId: app.id, key: "pro", name: "Pro" },
    db,
  );

  let price: Awaited<ReturnType<typeof createPrice>>;
  if (mode === "one_time") {
    price = await createPrice(
      {
        applicationId: app.id,
        productId: product.id,
        key: "one-time",
        currency: "USD",
        amountMinor: 999,
        billingType: "one_time",
      },
      db,
    );
  } else {
    price = await createPrice(
      {
        applicationId: app.id,
        productId: product.id,
        key: "monthly",
        currency: "USD",
        amountMinor: 1900,
        billingType: "recurring",
        recurringInterval: "month",
      },
      db,
    );
  }

  const providerConnection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "primary",
      mode: "test",
      credentials: { webhookSecret: "commerce-secret" },
    },
    db,
  );
  const checkout = await createCommerceCheckout(
    app.id,
    {
      externalCustomerId: "user-1",
      providerConnectionId: providerConnection.id,
      items: [{ priceId: price.id, quantity: mode === "one_time" ? 2 : 1 }],
      successUrl: "https://product.test/success?from=checkout",
      cancelUrl: "https://product.test/cancel",
    },
    db,
  );

  return {
    app,
    applicationCustomer,
    product,
    price,
    providerConnection,
    checkout,
  };
}

function webhookInput(
  payload: Record<string, unknown>,
  secret = "commerce-secret",
) {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    headers: {
      "x-monetplane-mock-signature": signMockWebhookPayload(rawBody, secret),
    },
  };
}

async function processFixtureWebhook(
  fixture: Fixture,
  payload: Record<string, unknown>,
) {
  return processProviderWebhook(
    fixture.app.id,
    fixture.providerConnection.id,
    webhookInput(payload),
    db,
  );
}

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  clearProviderAdaptersForTests();
  registerProviderAdapter(mockProviderAdapter);
  await db.delete(applications);
  await db.delete(customers);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

describe("commerce checkout", () => {
  it("derives amount/catalog context server-side and keeps redirect state pending", async () => {
    const fixture = await createFixture("one_time");

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    const [session] = await db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, fixture.checkout.checkoutSessionId))
      .limit(1);

    expect(order?.totalAmountMinor).toBe(1998);
    expect(order?.currency).toBe("USD");
    expect(order?.status).toBe("pending");
    expect(session?.status).toBe("open");
    expect(fixture.checkout.orderStatus).toBe("pending");
  });

  it("rejects a price owned by another application", async () => {
    const first = await createFixture("one_time");
    const otherApp = await createApplication(
      { slug: "other-catalog", name: "Other Catalog" },
      db,
    );
    const otherProduct = await createProduct(
      { applicationId: otherApp.id, key: "other", name: "Other" },
      db,
    );
    const otherPrice = await createPrice(
      {
        applicationId: otherApp.id,
        productId: otherProduct.id,
        key: "other",
        currency: "USD",
        amountMinor: 100,
        billingType: "one_time",
      },
      db,
    );

    await expect(
      createCommerceCheckout(
        first.app.id,
        {
          externalCustomerId: "user-1",
          providerConnectionId: first.providerConnection.id,
          items: [{ priceId: otherPrice.id, quantity: 1 }],
          successUrl: "https://product.test/success",
          cancelUrl: "https://product.test/cancel",
        },
        db,
      ),
    ).rejects.toThrow("do not belong");
  });
});

describe("commerce webhook inbox", () => {
  it("marks one-time orders paid only from a signed payment webhook and deduplicates concurrent replay", async () => {
    const fixture = await createFixture("one_time");
    const event = {
      id: "evt_payment_success_1",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T13:00:00.000Z",
      data: {
        provider_payment_id: "pay_provider_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1998,
        currency: "USD",
      },
    };

    const [first, second] = await Promise.all([
      processFixtureWebhook(fixture, event),
      processFixtureWebhook(fixture, event),
    ]);

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    const paymentRows = await db
      .select()
      .from(payments)
      .where(eq(payments.applicationId, fixture.app.id));
    const inboxRows = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.applicationId, fixture.app.id));

    expect(order?.status).toBe("paid");
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]?.status).toBe("succeeded");
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]?.status).toBe("processed");
    expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);
  });

  it("rejects invalid signatures before creating an inbox row", async () => {
    const fixture = await createFixture("one_time");

    await expect(
      processProviderWebhook(
        fixture.app.id,
        fixture.providerConnection.id,
        {
          rawBody: "{not-json",
          headers: { "x-monetplane-mock-signature": "00" },
        },
        db,
      ),
    ).rejects.toBeInstanceOf(InvalidProviderWebhookSignatureError);

    const rows = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.applicationId, fixture.app.id));
    expect(rows).toHaveLength(0);
  });

  it("audits unknown valid events without changing the order", async () => {
    const fixture = await createFixture("one_time");
    const result = await processFixtureWebhook(fixture, {
      id: "evt_unknown_1",
      type: "provider.new_future_event",
      occurred_at: "2026-08-18T13:01:00.000Z",
      data: { monetplane_order_id: fixture.checkout.orderId },
    });

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    const [inbox] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, result.webhookEventId))
      .limit(1);

    expect(result.status).toBe("ignored");
    expect(order?.status).toBe("pending");
    expect(inbox?.providerEventName).toBe("provider.new_future_event");
  });

  it("retains payment and order references for refunds", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(fixture, {
      id: "evt_refund_payment_success",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T13:02:00.000Z",
      data: {
        provider_payment_id: "pay_refundable_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1998,
        currency: "USD",
      },
    });
    await processFixtureWebhook(fixture, {
      id: "evt_refund_1",
      type: "payment.refunded",
      occurred_at: "2026-08-18T13:03:00.000Z",
      data: {
        provider_payment_id: "pay_refundable_1",
        provider_refund_id: "refund_provider_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1998,
        currency: "USD",
      },
    });

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_refundable_1"))
      .limit(1);
    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "refund_provider_1"))
      .limit(1);
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);

    expect(payment?.status).toBe("refunded");
    expect(refund?.paymentId).toBe(payment?.id);
    expect(refund?.orderId).toBe(fixture.checkout.orderId);
    expect(order?.status).toBe("refunded");
  });

  it("keeps cross-application order references isolated", async () => {
    const first = await createFixture("one_time");
    const second = await createFixture("one_time");

    await processFixtureWebhook(first, {
      id: "evt_cross_app_1",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T13:04:00.000Z",
      data: {
        provider_payment_id: "pay_cross_app_1",
        monetplane_order_id: second.checkout.orderId,
        monetplane_customer_id: second.applicationCustomer.customerId,
        amount_minor: 1998,
        currency: "USD",
      },
    });

    const [secondOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, second.checkout.orderId))
      .limit(1);
    const [firstPayment] = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.applicationId, first.app.id),
          eq(payments.providerPaymentId, "pay_cross_app_1"),
        ),
      )
      .limit(1);

    expect(secondOrder?.status).toBe("pending");
    expect(firstPayment?.orderId).toBeNull();
    expect(firstPayment?.customerId).toBeNull();
  });
});

describe("subscription lifecycle", () => {
  it("applies activation, failed renewal, recovery, cancellation, and expiration idempotently", async () => {
    const fixture = await createFixture("subscription");
    const baseData = {
      provider_subscription_id: "sub_provider_1",
      monetplane_order_id: fixture.checkout.orderId,
      monetplane_customer_id: fixture.applicationCustomer.customerId,
      subscription_period_start: "2026-08-18T00:00:00.000Z",
      subscription_period_end: "2026-09-18T00:00:00.000Z",
    };

    await processFixtureWebhook(fixture, {
      id: "evt_sub_created",
      type: "subscription.created",
      occurred_at: "2026-08-18T13:05:00.000Z",
      data: { ...baseData, subscription_status: "pending" },
    });
    await processFixtureWebhook(fixture, {
      id: "evt_sub_active",
      type: "subscription.activated",
      occurred_at: "2026-08-18T13:06:00.000Z",
      data: { ...baseData, subscription_status: "active" },
    });

    let [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, "sub_provider_1"))
      .limit(1);
    expect(subscription?.status).toBe("active");
    expect(
      await db
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, subscription?.id ?? "")),
    ).toHaveLength(1);

    await processFixtureWebhook(fixture, {
      id: "evt_sub_failed_renewal",
      type: "payment.failed",
      occurred_at: "2026-09-18T13:00:00.000Z",
      data: {
        provider_payment_id: "pay_failed_renewal_1",
        provider_subscription_id: "sub_provider_1",
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1900,
        currency: "USD",
      },
    });
    [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, "sub_provider_1"))
      .limit(1);
    expect(subscription?.status).toBe("past_due");

    await processFixtureWebhook(fixture, {
      id: "evt_sub_renewed",
      type: "subscription.renewed",
      occurred_at: "2026-09-19T13:00:00.000Z",
      data: {
        ...baseData,
        subscription_status: "active",
        subscription_period_start: "2026-09-18T00:00:00.000Z",
        subscription_period_end: "2026-10-18T00:00:00.000Z",
      },
    });
    [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, "sub_provider_1"))
      .limit(1);
    expect(subscription?.status).toBe("active");

    await processFixtureWebhook(fixture, {
      id: "evt_sub_cancelled",
      type: "subscription.cancelled",
      occurred_at: "2026-09-20T13:00:00.000Z",
      data: { ...baseData, cancel_at_period_end: false },
    });
    [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, "sub_provider_1"))
      .limit(1);
    expect(subscription?.status).toBe("cancelled");

    const expirationEvent = {
      id: "evt_sub_expired",
      type: "subscription.expired",
      occurred_at: "2026-10-18T13:00:00.000Z",
      data: baseData,
    };
    await processFixtureWebhook(fixture, expirationEvent);
    const replay = await processFixtureWebhook(fixture, expirationEvent);

    [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, "sub_provider_1"))
      .limit(1);
    expect(subscription?.status).toBe("expired");
    expect(replay.duplicate).toBe(true);
  });
});