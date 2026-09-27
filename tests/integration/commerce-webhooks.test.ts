import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import {
  createApplication,
  registerCallbackOrigin,
} from "../../src/modules/applications/service";
import {
  addProductGrantConfig,
  createPrice,
  createProduct,
} from "../../src/modules/catalog/service";
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
import { entitlementGrants } from "../../src/modules/entitlements/schema";
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
  const slug = `commerce-${mode.replace("_", "-")}-${Math.random().toString(36).slice(2, 8)}`;
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
  await addProductGrantConfig(
    {
      applicationId: app.id,
      productId: product.id,
      grantType: "entitlement",
      referenceKey: "feature.pro",
    },
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

  it("rejects open redirect attempts through unregistered callback URLs", async () => {
    const fixture = await createFixture("one_time");

    // successUrl from an unregistered origin (open redirect attempt)
    await expect(
      createCommerceCheckout(
        fixture.app.id,
        {
          externalCustomerId: "user-1",
          providerConnectionId: fixture.providerConnection.id,
          items: [{ priceId: fixture.price.id, quantity: 1 }],
          successUrl: "https://attacker.test/phish",
          cancelUrl: "https://product.test/cancel",
        },
        db,
      ),
    ).rejects.toThrow("not allowed");

    // cancelUrl from an unregistered origin
    await expect(
      createCommerceCheckout(
        fixture.app.id,
        {
          externalCustomerId: "user-1",
          providerConnectionId: fixture.providerConnection.id,
          items: [{ priceId: fixture.price.id, quantity: 1 }],
          successUrl: "https://product.test/success",
          cancelUrl: "https://evil.test/steal",
        },
        db,
      ),
    ).rejects.toThrow("not allowed");
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

describe("commerce webhook payment invariants (audit B5)", () => {
  async function orderGrants(applicationId: string, orderId: string) {
    return db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, applicationId),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, orderId),
        ),
      );
  }

  function paymentEventData(
    fixture: Fixture,
    overrides: Record<string, unknown>,
  ) {
    return {
      provider_payment_id: "pay_provider_x",
      monetplane_order_id: fixture.checkout.orderId,
      monetplane_customer_id: fixture.applicationCustomer.customerId,
      amount_minor: 1000,
      currency: "USD",
      ...overrides,
    };
  }

  it("fails payment events whose currency differs from the recorded currency and changes no rows (A)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(fixture, {
      id: "evt_cur_success_usd",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T14:00:00.000Z",
      data: paymentEventData(fixture, { provider_payment_id: "pay_cur_1" }),
    });

    await expect(
      processFixtureWebhook(fixture, {
        id: "evt_cur_refund_eur",
        type: "payment.refunded",
        occurred_at: "2026-08-18T14:01:00.000Z",
        data: paymentEventData(fixture, {
          provider_payment_id: "pay_cur_1",
          provider_refund_id: "refund_cur_eur",
          amount_minor: 500,
          currency: "EUR",
        }),
      }),
    ).rejects.toThrow(/currency mismatch/);

    // Lowercase "eur" must still mismatch (case-insensitive comparison).
    await expect(
      processFixtureWebhook(fixture, {
        id: "evt_cur_success_eur",
        type: "payment.succeeded",
        occurred_at: "2026-08-18T14:02:00.000Z",
        data: paymentEventData(fixture, {
          provider_payment_id: "pay_cur_2",
          currency: "eur",
        }),
      }),
    ).rejects.toThrow(/currency mismatch/);

    const paymentRows = await db
      .select()
      .from(payments)
      .where(eq(payments.applicationId, fixture.app.id));
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]).toMatchObject({
      providerPaymentId: "pay_cur_1",
      status: "succeeded",
      amountMinor: 1000,
      currency: "USD",
    });

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("paid");

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.applicationId, fixture.app.id));
    expect(refundRows).toHaveLength(0);

    const [failedEvent] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, "evt_cur_refund_eur"))
      .limit(1);
    expect(failedEvent?.status).toBe("failed");
    expect(failedEvent?.errorMessage).toContain("currency mismatch");
  });

  it("never overwrites the amount of an already settled payment (B)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(fixture, {
      id: "evt_amt_first",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T14:03:00.000Z",
      data: paymentEventData(fixture, { provider_payment_id: "pay_amt_1" }),
    });

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await processFixtureWebhook(fixture, {
        id: "evt_amt_drift",
        type: "payment.succeeded",
        // Same occurred_at as the first event: durable entitlement grants are
        // keyed on event time, and grant idempotency is not under test here.
        occurred_at: "2026-08-18T14:03:00.000Z",
        data: paymentEventData(fixture, {
          provider_payment_id: "pay_amt_1",
          amount_minor: 999999,
        }),
      });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("evt_amt_drift"),
      );
    } finally {
      consoleError.mockRestore();
    }

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_amt_1"))
      .limit(1);
    expect(payment?.amountMinor).toBe(1000);
    expect(payment?.currency).toBe("USD");
    expect(payment?.status).toBe("succeeded");
  });

  it("records a partial refund but keeps the payment succeeded and entitlements active (C+D)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(fixture, {
      id: "evt_part_success",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T14:05:00.000Z",
      data: paymentEventData(fixture, { provider_payment_id: "pay_part_1" }),
    });

    // Lowercase currency must be accepted against the uppercase record.
    await processFixtureWebhook(fixture, {
      id: "evt_part_refund",
      type: "payment.refunded",
      occurred_at: "2026-08-18T14:06:00.000Z",
      data: paymentEventData(fixture, {
        provider_payment_id: "pay_part_1",
        provider_refund_id: "refund_part_1",
        amount_minor: 500,
        currency: "usd",
      }),
    });

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_part_1"))
      .limit(1);
    expect(payment?.status).toBe("succeeded");
    expect(payment?.amountMinor).toBe(1000);

    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "refund_part_1"))
      .limit(1);
    expect(refund).toMatchObject({
      status: "succeeded",
      amountMinor: 500,
      paymentId: payment?.id,
      orderId: fixture.checkout.orderId,
    });

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("paid");

    const grants = await orderGrants(fixture.app.id, fixture.checkout.orderId);
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.status === "active")).toBe(true);
  });

  it("flips payment/order to refunded and revokes entitlements only when cumulative refunds reach the payment amount (D)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(fixture, {
      id: "evt_cum_success",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T14:07:00.000Z",
      data: paymentEventData(fixture, { provider_payment_id: "pay_cum_1" }),
    });
    await processFixtureWebhook(fixture, {
      id: "evt_cum_refund_1",
      type: "payment.refunded",
      occurred_at: "2026-08-18T14:08:00.000Z",
      data: paymentEventData(fixture, {
        provider_payment_id: "pay_cum_1",
        provider_refund_id: "refund_cum_1",
        amount_minor: 400,
      }),
    });

    const [partialPayment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_cum_1"))
      .limit(1);
    expect(partialPayment?.status).toBe("succeeded");
    const partialGrants = await orderGrants(
      fixture.app.id,
      fixture.checkout.orderId,
    );
    expect(partialGrants.every((grant) => grant.status === "active")).toBe(
      true,
    );

    await processFixtureWebhook(fixture, {
      id: "evt_cum_refund_2",
      type: "payment.refunded",
      occurred_at: "2026-08-18T14:09:00.000Z",
      data: paymentEventData(fixture, {
        provider_payment_id: "pay_cum_1",
        provider_refund_id: "refund_cum_2",
        amount_minor: 600,
      }),
    });

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_cum_1"))
      .limit(1);
    expect(payment?.status).toBe("refunded");
    expect(payment?.amountMinor).toBe(1000);

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("refunded");

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, payment?.id ?? ""));
    expect(
      refundRows
        .map((row) => row.amountMinor)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([400, 600]);

    const grants = await orderGrants(fixture.app.id, fixture.checkout.orderId);
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.status === "revoked")).toBe(true);
  });

  it("caps a refund event at the remaining captured amount (C)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(fixture, {
      id: "evt_cap_success",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T14:10:00.000Z",
      data: paymentEventData(fixture, { provider_payment_id: "pay_cap_1" }),
    });
    await processFixtureWebhook(fixture, {
      id: "evt_cap_refund",
      type: "payment.refunded",
      occurred_at: "2026-08-18T14:11:00.000Z",
      data: paymentEventData(fixture, {
        provider_payment_id: "pay_cap_1",
        provider_refund_id: "refund_cap_1",
        amount_minor: 5000,
      }),
    });

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_cap_1"))
      .limit(1);
    expect(payment).toMatchObject({ status: "refunded", amountMinor: 1000 });

    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "refund_cap_1"))
      .limit(1);
    expect(refund?.amountMinor).toBe(1000);

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("refunded");

    const grants = await orderGrants(fixture.app.id, fixture.checkout.orderId);
    expect(grants.every((grant) => grant.status === "revoked")).toBe(true);
  });

  it("idempotently skips refund events once the payment is already fully refunded (C)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(fixture, {
      id: "evt_skip_success",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T14:12:00.000Z",
      data: paymentEventData(fixture, { provider_payment_id: "pay_skip_1" }),
    });
    await processFixtureWebhook(fixture, {
      id: "evt_skip_refund_full",
      type: "payment.refunded",
      occurred_at: "2026-08-18T14:13:00.000Z",
      data: paymentEventData(fixture, {
        provider_payment_id: "pay_skip_1",
        provider_refund_id: "refund_skip_1",
        amount_minor: 1000,
      }),
    });

    const result = await processFixtureWebhook(fixture, {
      id: "evt_skip_refund_extra",
      type: "payment.refunded",
      occurred_at: "2026-08-18T14:14:00.000Z",
      data: paymentEventData(fixture, {
        provider_payment_id: "pay_skip_1",
        provider_refund_id: "refund_skip_2",
        amount_minor: 100,
      }),
    });
    expect(result.status).toBe("ignored");

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.applicationId, fixture.app.id));
    expect(refundRows.map((row) => row.providerRefundId)).toEqual([
      "refund_skip_1",
    ]);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_skip_1"))
      .limit(1);
    expect(payment).toMatchObject({ status: "refunded", amountMinor: 1000 });

    const [skippedEvent] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, "evt_skip_refund_extra"))
      .limit(1);
    expect(skippedEvent?.status).toBe("ignored");
    expect(skippedEvent?.errorMessage).toContain(
      "refund exceeds payment amount",
    );
  });

  it("seeds an out-of-order refund's payment row from the order total, not the refund amount (C)", async () => {
    const fixture = await createFixture("one_time");

    // Refund arrives with no prior success event for this payment.
    await processFixtureWebhook(fixture, {
      id: "evt_rf_first",
      type: "payment.refunded",
      occurred_at: "2026-08-18T14:20:00.000Z",
      data: paymentEventData(fixture, {
        provider_payment_id: "pay_rf_1",
        provider_refund_id: "refund_rf_1",
        amount_minor: 500,
      }),
    });

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_rf_1"))
      .limit(1);
    expect(payment?.amountMinor).toBe(1998);
    expect(payment?.status).toBe("succeeded");

    // A second refund reaching the order total closes it out.
    await processFixtureWebhook(fixture, {
      id: "evt_rf_second",
      type: "payment.refunded",
      occurred_at: "2026-08-18T14:21:00.000Z",
      data: paymentEventData(fixture, {
        provider_payment_id: "pay_rf_1",
        provider_refund_id: "refund_rf_2",
        amount_minor: 1498,
      }),
    });

    const [refunded] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_rf_1"))
      .limit(1);
    expect(refunded?.status).toBe("refunded");

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, refunded?.id ?? ""));
    expect(
      refundRows.map((row) => row.amountMinor ?? 0).sort((a, b) => a - b),
    ).toEqual([500, 1498]);
  });
});

describe("refund fact idempotency & serialization (MP-REV-01/02)", () => {
  function refundEventData(
    fixture: Fixture,
    overrides: {
      id: string;
      type?: "payment.refunded" | "payment.succeeded";
      providerRefundId?: string;
      amountMinor?: number;
    },
  ) {
    return {
      id: overrides.id,
      type: overrides.type ?? "payment.refunded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_fact_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: overrides.amountMinor ?? 1000,
        currency: "USD",
        ...(overrides.providerRefundId
          ? { provider_refund_id: overrides.providerRefundId }
          : {}),
      },
    };
  }

  async function orderGrantsFor(applicationId: string, orderId: string) {
    return db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, applicationId),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, orderId),
        ),
      );
  }

  it("treats a repeated refund id (different event ids) as an idempotent replay, not new headroom (MP-REV-01)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(
      fixture,
      refundEventData(fixture, {
        id: "evt_fact_success",
        type: "payment.succeeded",
      }),
    );

    await processFixtureWebhook(
      fixture,
      refundEventData(fixture, {
        id: "evt_fact_r1",
        providerRefundId: "R",
        amountMinor: 700,
      }),
    );
    const replay = await processFixtureWebhook(
      fixture,
      refundEventData(fixture, {
        id: "evt_fact_r2",
        providerRefundId: "R",
        amountMinor: 700,
      }),
    );

    expect(replay.status).toBe("ignored");

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.applicationId, fixture.app.id));
    expect(refundRows).toHaveLength(1);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_fact_1"))
      .limit(1);
    expect(payment).toMatchObject({ status: "succeeded", amountMinor: 1000 });
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("paid");

    const grants = await orderGrantsFor(
      fixture.app.id,
      fixture.checkout.orderId,
    );
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.status === "active")).toBe(true);

    const [replayedEvent] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, "evt_fact_r2"))
      .limit(1);
    expect(replayedEvent?.status).toBe("ignored");
    expect(replayedEvent?.errorMessage).toContain("already recorded");
  });

  it("never overwrites a succeeded refund fact on an amount conflict (MP-REV-01)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(
      fixture,
      refundEventData(fixture, {
        id: "evt_conf_success",
        type: "payment.succeeded",
        amountMinor: 1000,
      }),
    );
    await processFixtureWebhook(
      fixture,
      refundEventData(fixture, {
        id: "evt_conf_r1",
        providerRefundId: "R",
        amountMinor: 700,
      }),
    );

    await expect(
      processFixtureWebhook(
        fixture,
        refundEventData(fixture, {
          id: "evt_conf_r2",
          providerRefundId: "R",
          amountMinor: 600,
        }),
      ),
    ).rejects.toThrow(/refund fact R conflict/);

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.applicationId, fixture.app.id));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({ amountMinor: 700 });

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_fact_1"))
      .limit(1);
    expect(payment?.status).toBe("succeeded");

    const [conflicted] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, "evt_conf_r2"))
      .limit(1);
    expect(conflicted?.status).toBe("failed");
    expect(conflicted?.errorMessage).toContain("requires reconciliation");
  });

  it("serializes concurrent first-refunds when the payment row does not exist yet (MP-REV-02)", async () => {
    const fixture = await createFixture("one_time");

    // No success event: both refund events arrive against a missing payment
    // row. The per-payment advisory lock must serialize planning so the
    // second plan is computed against the first one's committed state.
    const results = await Promise.allSettled([
      processProviderWebhook(
        fixture.app.id,
        fixture.providerConnection.id,
        webhookInput(
          refundEventData(fixture, {
            id: "evt_conc_r1",
            providerRefundId: "RC1",
            amountMinor: 600,
          }),
        ),
        db,
      ),
      processProviderWebhook(
        fixture.app.id,
        fixture.providerConnection.id,
        webhookInput(
          refundEventData(fixture, {
            id: "evt_conc_r2",
            providerRefundId: "RC2",
            amountMinor: 600,
          }),
        ),
        db,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_fact_1"))
      .limit(1);
    expect(payment?.status).toBe("succeeded");

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.applicationId, fixture.app.id));
    expect(refundRows).toHaveLength(2);
    const totalRefunded = refundRows.reduce(
      (sum, row) => sum + (row.amountMinor ?? 0),
      0,
    );
    expect(totalRefunded).toBeLessThanOrEqual(payment?.amountMinor ?? 0);

    // Refund-first flow: the order is driven to paid by a success event,
    // which never arrived — the invariant under test is that no false
    // terminal state was created and the refund total stays capped.
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("pending");
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
