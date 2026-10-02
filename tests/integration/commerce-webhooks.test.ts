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
import { creditTransactions } from "../../src/modules/credits/schema";
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
            amountMinor: 1500,
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
            amountMinor: 1500,
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
    // 1500 + capped 498 = 1998 = cumulative-full refund: the terminal
    // transition to refunded is the expected outcome here, and the cap is
    // what makes the second 1500 land as 498.
    expect(payment?.status).toBe("refunded");

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
    // 1500 + 1500 against captured 1998: without the advisory lock, both
    // plans would compute against full headroom (3000 > 1998) — the exact
    // total below only holds when the second plan recomputes against the
    // first one's committed state.
    expect(totalRefunded).toBe(1998);

    // Refund-first flow: the order is driven to paid by a success event,
    // which never arrived. Cumulative-full here is 1998/1998, so the order
    // legitimately closes out as refunded via the refund path.
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("refunded");
  });
});

describe("payment/order state machine monotonicity (MP-REV-03)", () => {
  function lifecycleEvent(
    fixture: Fixture,
    overrides: {
      id: string;
      type: "payment.succeeded" | "payment.failed" | "payment.refunded";
      providerRefundId?: string;
      amountMinor?: number;
    },
  ) {
    return {
      id: overrides.id,
      type: overrides.type,
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_sm_1",
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

  async function paymentState(paymentId: string) {
    const [row] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, paymentId))
      .limit(1);
    return row;
  }

  it("keeps a refunded payment terminal when a late success arrives (MP-REV-03)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(
      fixture,
      lifecycleEvent(fixture, { id: "evt_sm_ok", type: "payment.succeeded" }),
    );
    await processFixtureWebhook(
      fixture,
      lifecycleEvent(fixture, {
        id: "evt_sm_refund",
        type: "payment.refunded",
        providerRefundId: "RSM",
        amountMinor: 1000,
      }),
    );
    const before = await paymentState("pay_sm_1");
    expect(before?.status).toBe("refunded");

    const result = await processFixtureWebhook(
      fixture,
      lifecycleEvent(fixture, { id: "evt_sm_late", type: "payment.succeeded" }),
    );
    expect(result.status).toBe("ignored");

    const after = await paymentState("pay_sm_1");
    expect(after?.status).toBe("refunded");
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("refunded");

    // No duplicate grants fire on the late success.
    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, fixture.app.id),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, fixture.checkout.orderId),
        ),
      );
    expect(grants.every((grant) => grant.status === "revoked")).toBe(true);

    const [late] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, "evt_sm_late"))
      .limit(1);
    expect(late?.status).toBe("ignored");
    expect(late?.errorMessage).toContain("terminal refund");
  });

  it("never regresses a succeeded payment to failed on a late failure event (MP-REV-03)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(
      fixture,
      lifecycleEvent(fixture, { id: "evt_sm_ok2", type: "payment.succeeded" }),
    );

    await processFixtureWebhook(
      fixture,
      lifecycleEvent(fixture, { id: "evt_sm_fail", type: "payment.failed" }),
    );

    const row = await paymentState("pay_sm_1");
    expect(row?.status).toBe("succeeded");
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("paid");
  });

  it("grants fire exactly once across success → partial refund → late duplicate success (MP-REV-03)", async () => {
    const fixture = await createFixture("one_time");
    await processFixtureWebhook(
      fixture,
      lifecycleEvent(fixture, { id: "evt_sm_ok3", type: "payment.succeeded" }),
    );
    await processFixtureWebhook(
      fixture,
      lifecycleEvent(fixture, {
        id: "evt_sm_p50",
        type: "payment.refunded",
        providerRefundId: "RP50",
        amountMinor: 500,
      }),
    );

    await processFixtureWebhook(
      fixture,
      lifecycleEvent(fixture, {
        id: "evt_sm_late2",
        type: "payment.succeeded",
      }),
    );

    const row = await paymentState("pay_sm_1");
    expect(row?.status).toBe("succeeded");
    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, fixture.app.id),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, fixture.checkout.orderId),
        ),
      );
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.status === "active")).toBe(true);
  });
});

describe("refund fact pending lifecycle (B1)", () => {
  async function seedPendingRefundRow(
    fixture: Fixture,
    paymentId: string,
    providerRefundId: string,
    amountMinor: number | null,
  ) {
    await db.insert(refunds).values({
      id: `ref_${providerRefundId}`,
      applicationId: fixture.app.id,
      orderId: fixture.checkout.orderId,
      paymentId,
      providerConnectionId: fixture.providerConnection.id,
      providerRefundId,
      environment: "test",
      status: "pending",
      amountMinor,
    });
  }

  async function succeedPaymentEvent(
    fixture: Fixture,
    eventId: string,
    paymentId = "pay_b1_1",
  ) {
    const payload = {
      id: eventId,
      type: "payment.succeeded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: paymentId,
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1998,
        currency: "USD",
      },
    };
    return processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(payload),
      db,
    );
  }

  function refundEvent(
    fixture: Fixture,
    overrides: {
      id: string;
      providerRefundId: string;
      amountMinor: number;
      paymentId?: string;
    },
  ) {
    const payload = {
      id: overrides.id,
      type: "payment.refunded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: overrides.paymentId ?? "pay_b1_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: overrides.amountMinor,
        currency: "USD",
        provider_refund_id: overrides.providerRefundId,
      },
    };
    return processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(payload),
      db,
    );
  }

  async function paymentRow(paymentId: string) {
    const [row] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, paymentId))
      .limit(1);
    return row;
  }

  it("upgrades a pending fact to succeeded with the confirmed amount, never re-planned through Math.min", async () => {
    const fixture = await createFixture("one_time");
    await succeedPaymentEvent(fixture, "evt_b1_s1");
    const payment = await paymentRow("pay_b1_1");
    if (!payment) throw new Error("payment missing");
    await seedPendingRefundRow(fixture, payment.id, "R1", 700);

    // Old bug: pending counted as alreadyRefunded -> applied=min(700,300)=300
    // and the row was overwritten to 300 with a false full refund.
    const result = await refundEvent(fixture, {
      id: "evt_b1_r1",
      providerRefundId: "R1",
      amountMinor: 700,
    });
    expect(result.status).toBe("processed");

    const [refundRow] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "R1"))
      .limit(1);
    expect(refundRow).toMatchObject({ status: "succeeded", amountMinor: 700 });

    const after = await paymentRow("pay_b1_1");
    expect(after?.status).toBe("succeeded");
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("paid");
  });

  it("upgrades a full-amount pending fact instead of stranding it as ignored", async () => {
    const fixture = await createFixture("one_time");
    await succeedPaymentEvent(fixture, "evt_b1_s2");
    const payment = await paymentRow("pay_b1_1");
    if (!payment) throw new Error("payment missing");
    await seedPendingRefundRow(fixture, payment.id, "RFULL", 1998);

    const result = await refundEvent(fixture, {
      id: "evt_b1_r2",
      providerRefundId: "RFULL",
      amountMinor: 1998,
    });
    expect(result.status).toBe("processed");

    const [refundRow] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "RFULL"))
      .limit(1);
    expect(refundRow).toMatchObject({ status: "succeeded", amountMinor: 1998 });

    const after = await paymentRow("pay_b1_1");
    expect(after?.status).toBe("refunded");
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("refunded");
    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, fixture.app.id),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, fixture.checkout.orderId),
        ),
      );
    expect(grants.every((grant) => grant.status === "revoked")).toBe(true);
  });

  it("takes the provider's corrected amount when a pending fact is confirmed with a different amount", async () => {
    const fixture = await createFixture("one_time");
    await succeedPaymentEvent(fixture, "evt_b1_s3");
    const payment = await paymentRow("pay_b1_1");
    if (!payment) throw new Error("payment missing");
    await seedPendingRefundRow(fixture, payment.id, "RCORR", 1998);

    await refundEvent(fixture, {
      id: "evt_b1_r3",
      providerRefundId: "RCORR",
      amountMinor: 500,
    });

    const [refundRow] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "RCORR"))
      .limit(1);
    expect(refundRow).toMatchObject({ status: "succeeded", amountMinor: 500 });
    const after = await paymentRow("pay_b1_1");
    expect(after?.status).toBe("succeeded");
  });

  it("supersedes a synthetic journal refund id when the real provider refund id lands", async () => {
    const fixture = await createFixture("one_time");
    await succeedPaymentEvent(fixture, "evt_b1_s4");
    const payment = await paymentRow("pay_b1_1");
    if (!payment) throw new Error("payment missing");
    // Synthetic id shape used by the Creem journal path: refund:<paymentId>
    await seedPendingRefundRow(
      fixture,
      payment.id,
      `refund:${"pay_b1_1"}`,
      1998,
    );

    const result = await refundEvent(fixture, {
      id: "evt_b1_r4",
      providerRefundId: "real_refund_1",
      amountMinor: 1998,
    });
    expect(result.status).toBe("processed");

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.applicationId, fixture.app.id));
    expect(refundRows).toHaveLength(2);
    const byId = Object.fromEntries(
      refundRows.map((row) => [row.providerRefundId, row]),
    );
    expect(byId["refund:pay_b1_1"]).toMatchObject({ status: "superseded" });
    expect(byId.real_refund_1).toMatchObject({
      status: "succeeded",
      amountMinor: 1998,
    });

    const after = await paymentRow("pay_b1_1");
    expect(after?.status).toBe("refunded");
  });
});

describe("order snapshot freshness under concurrent payment events (B2)", () => {
  function paymentEventPayload(
    fixture: Fixture,
    overrides: {
      id: string;
      type: "payment.succeeded" | "payment.failed" | "payment.refunded";
      providerPaymentId: string;
      providerRefundId?: string;
      amountMinor?: number;
    },
  ) {
    return {
      id: overrides.id,
      type: overrides.type,
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: overrides.providerPaymentId,
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: overrides.amountMinor ?? 1998,
        currency: "USD",
        ...(overrides.providerRefundId
          ? { provider_refund_id: overrides.providerRefundId }
          : {}),
      },
    };
  }

  async function finalOrderState(orderId: string) {
    const [row] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    return row;
  }

  it("keeps the order paid when a partial refund races a success event (multi-round)", async () => {
    // Pre-fix: both transactions read order=pending before the lock; the
    // refund then wrote its stale pending over the committed paid.
    for (let round = 0; round < 5; round++) {
      const fixture = await createFixture("one_time");
      const paymentId = `pay_b2_sr_${round}`;
      const race = await Promise.allSettled([
        processProviderWebhook(
          fixture.app.id,
          fixture.providerConnection.id,
          webhookInput(
            paymentEventPayload(fixture, {
              id: `evt_b2_s_${round}`,
              type: "payment.succeeded",
              providerPaymentId: paymentId,
            }),
          ),
          db,
        ),
        processProviderWebhook(
          fixture.app.id,
          fixture.providerConnection.id,
          webhookInput(
            paymentEventPayload(fixture, {
              id: `evt_b2_r_${round}`,
              type: "payment.refunded",
              providerPaymentId: paymentId,
              providerRefundId: `RB2_${round}`,
              amountMinor: 500,
            }),
          ),
          db,
        ),
      ]);
      // A rejected event must fail the test loudly, not pass via a lucky
      // final state (round-3 review note).
      expect(race.every((r) => r.status === "fulfilled")).toBe(true);

      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.providerPaymentId, paymentId))
        .limit(1);
      expect(payment?.status).toBe("succeeded");
      const order = await finalOrderState(fixture.checkout.orderId);
      expect(order?.status).toBe("paid");
    }
  });

  it("keeps the order consistent when a late failure races a success event (multi-round)", async () => {
    for (let round = 0; round < 5; round++) {
      const fixture = await createFixture("one_time");
      const paymentId = `pay_b2_sf_${round}`;
      const race = await Promise.allSettled([
        processProviderWebhook(
          fixture.app.id,
          fixture.providerConnection.id,
          webhookInput(
            paymentEventPayload(fixture, {
              id: `evt_b2_s2_${round}`,
              type: "payment.succeeded",
              providerPaymentId: paymentId,
            }),
          ),
          db,
        ),
        processProviderWebhook(
          fixture.app.id,
          fixture.providerConnection.id,
          webhookInput(
            paymentEventPayload(fixture, {
              id: `evt_b2_f_${round}`,
              type: "payment.failed",
              providerPaymentId: paymentId,
            }),
          ),
          db,
        ),
      ]);
      expect(race.every((r) => r.status === "fulfilled")).toBe(true);

      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.providerPaymentId, paymentId))
        .limit(1);
      expect(payment?.status).toBe("succeeded");
      const order = await finalOrderState(fixture.checkout.orderId);
      expect(order?.status).toBe("paid");
    }
  });
});

describe("duplicate-success marker and late-failure semantics (B3/B4)", () => {
  async function seedCreditsOnlyFixture() {
    const slug = `credits-only-${Math.random().toString(36).slice(2, 8)}`;
    const app = await createApplication({ slug, name: slug }, db);
    await registerCallbackOrigin(app.id, "https://product.test/success", db);
    await registerCallbackOrigin(app.id, "https://product.test/cancel", db);
    const applicationCustomer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "user-1", email: "c@test" },
      db,
    );
    const product = await createProduct(
      { applicationId: app.id, key: "pack", name: "Pack" },
      db,
    );
    await addProductGrantConfig(
      {
        applicationId: app.id,
        productId: product.id,
        grantType: "credit",
        referenceKey: "gen.credits",
        quantity: 100,
      },
      db,
    );
    const price = await createPrice(
      {
        applicationId: app.id,
        productId: product.id,
        key: "one-time",
        currency: "USD",
        amountMinor: 1998,
        billingType: "one_time",
      },
      db,
    );
    const connection = await createProviderConnection(
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
        items: [{ priceId: price.id, quantity: 1 }],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      },
      db,
    );
    return {
      app,
      applicationCustomer,
      providerConnection: connection,
      checkout,
    };
  }

  function successPayload(
    fixture: { checkout: { orderId: string } },
    id: string,
    paymentId: string,
  ) {
    return {
      id,
      type: "payment.succeeded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: paymentId,
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: "user-1",
        amount_minor: 1998,
        currency: "USD",
      },
    };
  }

  it("ignores a replayed success for a credits-only order (B3: order status is the marker)", async () => {
    const fixture = await seedCreditsOnlyFixture();
    const first = await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(successPayload(fixture, "evt_b3_c1", "pay_b3_c1")),
      db,
    );
    expect(first.status).toBe("processed");

    const second = await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(successPayload(fixture, "evt_b3_c2", "pay_b3_c1")),
      db,
    );
    expect(second.status).toBe("ignored");

    const grantRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationId, fixture.app.id));
    expect(grantRows).toHaveLength(1);
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("paid");
  });

  it("ignores a replayed success for a subscription-billed order (B3)", async () => {
    const fixture = await createFixture("subscription");
    const first = await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(successPayload(fixture, "evt_b3_s1", "pay_b3_s1")),
      db,
    );
    expect(first.status).toBe("processed");
    const second = await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(successPayload(fixture, "evt_b3_s2", "pay_b3_s1")),
      db,
    );
    expect(second.status).toBe("ignored");
  });

  it("acknowledges a late failure for a settled payment without side effects (B4)", async () => {
    const fixture = await createFixture("one_time");
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(successPayload(fixture, "evt_b4_s1", "pay_b4_1")),
      db,
    );

    const late = await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput({
        id: "evt_b4_f1",
        type: "payment.failed",
        occurred_at: new Date().toISOString(),
        data: {
          provider_payment_id: "pay_b4_1",
          monetplane_order_id: fixture.checkout.orderId,
          monetplane_customer_id: fixture.applicationCustomer.customerId,
          provider_subscription_id: "sub_b4_1",
          amount_minor: 1998,
          currency: "USD",
        },
      }),
      db,
    );
    expect(late.status).toBe("ignored");

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_b4_1"))
      .limit(1);
    expect(payment?.status).toBe("succeeded");
    expect(payment?.orderId).toBe(fixture.checkout.orderId);
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("paid");
    const [inboxRow] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, "evt_b4_f1"))
      .limit(1);
    expect(inboxRow?.status).toBe("ignored");
    expect(inboxRow?.errorMessage).toContain("already-settled");
  });

  it("still processes an independent renewal failure with a new payment id (B4)", async () => {
    const fixture = await createFixture("one_time");
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(successPayload(fixture, "evt_b4_s2", "pay_b4_2")),
      db,
    );

    const renewal = await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput({
        id: "evt_b4_f2",
        type: "payment.failed",
        occurred_at: new Date().toISOString(),
        data: {
          provider_payment_id: "pay_b4_renewal",
          monetplane_order_id: fixture.checkout.orderId,
          monetplane_customer_id: fixture.applicationCustomer.customerId,
          provider_subscription_id: "sub_b4_2",
          amount_minor: 1998,
          currency: "USD",
        },
      }),
      db,
    );
    expect(renewal.status).toBe("processed");
  });

  it("rejects zero and negative refund amounts as permanent failures (§二E)", async () => {
    const fixture = await createFixture("one_time");
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(successPayload(fixture, "evt_b4e_s1", "pay_b4e_1")),
      db,
    );

    for (const amount of [0, -100]) {
      await expect(
        processProviderWebhook(
          fixture.app.id,
          fixture.providerConnection.id,
          webhookInput({
            id: `evt_b4e_r_${amount}`,
            type: "payment.refunded",
            occurred_at: new Date().toISOString(),
            data: {
              provider_payment_id: "pay_b4e_1",
              monetplane_order_id: fixture.checkout.orderId,
              monetplane_customer_id: fixture.applicationCustomer.customerId,
              amount_minor: amount,
              currency: "USD",
              provider_refund_id: `RB4E_${amount}`,
            },
          }),
          db,
        ),
      ).rejects.toThrow(/positive whole number/);
    }

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.applicationId, fixture.app.id));
    expect(refundRows).toHaveLength(0);
  });
});

describe("round-3 review regressions", () => {
  async function paymentRowBy(providerPaymentId: string) {
    const [row] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, providerPaymentId))
      .limit(1);
    return row;
  }

  it("T1: a pending-fact upgrade is never re-clamped by the generic planner (B1)", async () => {
    const fixture = await createFixture("one_time");
    const payload = (
      id: string,
      type: string,
      extra: Record<string, unknown>,
    ) => ({
      id,
      type,
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_t1_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1998,
        currency: "USD",
        ...extra,
      },
    });
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(payload("evt_t1_s", "payment.succeeded", {})),
      db,
    );
    // Another refund already consumed most of the headroom.
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(
        payload("evt_t1_r1", "payment.refunded", {
          provider_refund_id: "RT1_A",
          amount_minor: 1498,
        }),
      ),
      db,
    );
    const payment = await paymentRowBy("pay_t1_1");
    if (!payment) throw new Error("payment missing");
    await db.insert(refunds).values({
      id: "ref_t1_pending",
      applicationId: fixture.app.id,
      orderId: fixture.checkout.orderId,
      paymentId: payment.id,
      providerConnectionId: fixture.providerConnection.id,
      providerRefundId: "RT1_B",
      environment: "test",
      status: "pending",
      amountMinor: 700,
    });

    // Confirming 700 with remaining=500: the generic Math.min would
    // re-clamp the confirmed fact to 500 (round-3 finding 1).
    const result = await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(
        payload("evt_t1_r2", "payment.refunded", {
          provider_refund_id: "RT1_B",
          amount_minor: 700,
        }),
      ),
      db,
    );
    expect(result.status).toBe("processed");

    const [row] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "RT1_B"))
      .limit(1);
    expect(row).toMatchObject({ status: "succeeded", amountMinor: 700 });
    const after = await paymentRowBy("pay_t1_1");
    expect(after?.status).toBe("refunded");
  });

  it("T2: a provider-id-only full refund revokes the order and its entitlements (round-3 finding 2)", async () => {
    const fixture = await createFixture("one_time");
    const payload = (
      id: string,
      type: string,
      extra: Record<string, unknown>,
    ) => ({
      id,
      type,
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_t2_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1998,
        currency: "USD",
        ...extra,
      },
    });
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(payload("evt_t2_s", "payment.succeeded", {})),
      db,
    );

    // The refund notification carries ONLY provider ids — no order/customer
    // metadata. The order association must be recovered from the payment.
    const result = await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput({
        id: "evt_t2_r",
        type: "payment.refunded",
        occurred_at: new Date().toISOString(),
        data: {
          provider_payment_id: "pay_t2_1",
          provider_refund_id: "RT2",
          amount_minor: 1998,
          currency: "USD",
        },
      }),
      db,
    );
    expect(result.status).toBe("processed");

    const payment = await paymentRowBy("pay_t2_1");
    expect(payment?.status).toBe("refunded");
    expect(payment?.orderId).toBe(fixture.checkout.orderId);
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    expect(order?.status).toBe("refunded");
    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, fixture.app.id),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, fixture.checkout.orderId),
        ),
      );
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.status === "revoked")).toBe(true);
  });
});

describe("round-4 review regressions (F1/F2)", () => {
  async function succeed(fixture: Fixture, paymentId: string, eventId: string) {
    return processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput({
        id: eventId,
        type: "payment.succeeded",
        occurred_at: new Date().toISOString(),
        data: {
          provider_payment_id: paymentId,
          monetplane_order_id: fixture.checkout.orderId,
          monetplane_customer_id: fixture.applicationCustomer.customerId,
          amount_minor: 1998,
          currency: "USD",
        },
      }),
      db,
    );
  }

  function confirmRefund(
    fixture: Fixture,
    paymentId: string,
    refundId: string,
    amountMinor: number,
    eventId: string,
    monetplaneOrderId?: string,
  ) {
    return processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput({
        id: eventId,
        type: "payment.refunded",
        occurred_at: new Date().toISOString(),
        data: {
          provider_payment_id: paymentId,
          monetplane_order_id: monetplaneOrderId,
          monetplane_customer_id: fixture.applicationCustomer.customerId,
          amount_minor: amountMinor,
          currency: "USD",
          provider_refund_id: refundId,
        },
      }),
      db,
    );
  }

  async function seedPendingRefund(
    fixture: Fixture,
    paymentId: string,
    refundId: string,
    amountMinor: number,
  ) {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, paymentId))
      .limit(1);
    if (!payment) throw new Error("payment missing");
    await db.insert(refunds).values({
      id: `ref_${refundId}`,
      applicationId: fixture.app.id,
      orderId: fixture.checkout.orderId,
      paymentId: payment.id,
      providerConnectionId: fixture.providerConnection.id,
      providerRefundId: refundId,
      environment: "test",
      status: "pending",
      amountMinor,
    });
  }

  async function stateTriple(fixture: Fixture, paymentId: string) {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, paymentId))
      .limit(1);
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, fixture.app.id),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, fixture.checkout.orderId),
        ),
      );
    return {
      payment: payment?.status,
      order: order?.status,
      grantsActive: grants.every((g) => g.status === "active"),
    };
  }

  it("Test A: pending refunds reserve headroom but never decide terminality (F1)", async () => {
    const fixture = await createFixture("one_time");
    await succeed(fixture, "pay_f1_1", "evt_f1_s");
    await seedPendingRefund(fixture, "pay_f1_1", "FA", 700);
    await seedPendingRefund(fixture, "pay_f1_1", "FB", 1500);

    // Confirm ONLY A: confirmed 700 < 1998 — B is still unconfirmed.
    const confirmA = await confirmRefund(
      fixture,
      "pay_f1_1",
      "FA",
      700,
      "evt_f1_ra",
    );
    expect(confirmA.status).toBe("processed");
    await expect(stateTriple(fixture, "pay_f1_1")).resolves.toEqual({
      payment: "succeeded",
      order: "paid",
      grantsActive: true,
    });

    // B later CONFIRMS: 700 + 1500 >= 1998 -> terminal now.
    const confirmB = await confirmRefund(
      fixture,
      "pay_f1_1",
      "FB",
      1500,
      "evt_f1_rb",
    );
    expect(confirmB.status).toBe("processed");
    await expect(stateTriple(fixture, "pay_f1_1")).resolves.toEqual({
      payment: "refunded",
      order: "refunded",
      grantsActive: false,
    });
  });

  it("Test A-variant: a pending refund that later fails never decides terminality (F1)", async () => {
    const fixture = await createFixture("one_time");
    await succeed(fixture, "pay_f1_2", "evt_f1_s2");
    await seedPendingRefund(fixture, "pay_f1_2", "FC", 700);
    await seedPendingRefund(fixture, "pay_f1_2", "FD", 1500);

    await confirmRefund(fixture, "pay_f1_2", "FC", 700, "evt_f1_rc");

    // D fails at the provider (journal path records the failed fact).
    await db
      .update(refunds)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(refunds.providerRefundId, "FD"));

    await expect(stateTriple(fixture, "pay_f1_2")).resolves.toEqual({
      payment: "succeeded",
      order: "paid",
      grantsActive: true,
    });
  });

  it("Test B-1: an event carrying a nonexistent order id cannot bypass the binding guard (F2)", async () => {
    const fixture = await createFixture("one_time");
    await succeed(fixture, "pay_f2_2", "evt_f2_s2");

    await expect(
      confirmRefund(
        fixture,
        "pay_f2_2",
        "RF2B1",
        500,
        "evt_f2_r2",
        "ord_does_not_exist",
      ),
    ).rejects.toThrow(/already bound to order/);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_f2_2"))
      .limit(1);
    expect(payment?.status).toBe("succeeded");
    expect(payment?.orderId).toBe(fixture.checkout.orderId);
    expect(
      await db
        .select()
        .from(refunds)
        .where(eq(refunds.providerRefundId, "RF2B1")),
    ).toHaveLength(0);
    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, fixture.app.id),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, fixture.checkout.orderId),
        ),
      );
    expect(grants.every((g) => g.status === "active")).toBe(true);
  });

  it("Test B-2: an event carrying another application's order id cannot bypass the binding guard (F2)", async () => {
    const fixture = await createFixture("one_time");
    await succeed(fixture, "pay_f2_3", "evt_f2_s3");

    const otherFixture = await createFixture("one_time");
    await expect(
      confirmRefund(
        fixture,
        "pay_f2_3",
        "RF2B2",
        500,
        "evt_f2_r3",
        otherFixture.checkout.orderId,
      ),
    ).rejects.toThrow(/already bound to order/);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_f2_3"))
      .limit(1);
    expect(payment?.orderId).toBe(fixture.checkout.orderId);
    expect(payment?.status).toBe("succeeded");
    expect(
      await db
        .select()
        .from(refunds)
        .where(eq(refunds.providerRefundId, "RF2B2")),
    ).toHaveLength(0);
  });

  it("Test B-3: an event cannot rebind a payment to a different customer (binding family P1)", async () => {
    const fixture = await createFixture("one_time");
    await succeed(fixture, "pay_f2_4", "evt_f2_s4");

    const otherCustomer = await createApplicationCustomer(
      {
        applicationId: fixture.app.id,
        externalCustomerId: "user-2",
        email: "other@example.test",
      },
      db,
    );

    const payload = {
      id: "evt_f2_r4",
      type: "payment.refunded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_f2_4",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: otherCustomer.customerId,
        amount_minor: 500,
        currency: "USD",
        provider_refund_id: "RF2B3",
      },
    };
    await expect(
      processProviderWebhook(
        fixture.app.id,
        fixture.providerConnection.id,
        webhookInput(payload),
        db,
      ),
    ).rejects.toThrow(/already bound to customer/);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_f2_4"))
      .limit(1);
    expect(payment?.customerId).toBe(fixture.applicationCustomer.customerId);
    expect(payment?.status).toBe("succeeded");
    expect(
      await db
        .select()
        .from(refunds)
        .where(eq(refunds.providerRefundId, "RF2B3")),
    ).toHaveLength(0);
  });

  it("Test B: an event cannot rebind a payment to a different order (F2)", async () => {
    const fixture = await createFixture("one_time");
    await succeed(fixture, "pay_f2_1", "evt_f2_s");

    // A second, unrelated order in the same application.
    const second = await createCommerceCheckout(
      fixture.app.id,
      {
        externalCustomerId: "user-1",
        items: [{ priceId: fixture.price.id, quantity: 1 }],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      },
      db,
    );

    await expect(
      confirmRefund(
        fixture,
        "pay_f2_1",
        "RF2",
        500,
        "evt_f2_r",
        second.orderId,
      ),
    ).rejects.toThrow(/already bound to order/);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_f2_1"))
      .limit(1);
    expect(payment?.orderId).toBe(fixture.checkout.orderId);

    const [orderA] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, fixture.checkout.orderId))
      .limit(1);
    const [orderB] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, second.orderId))
      .limit(1);
    expect(orderA?.status).toBe("paid");
    expect(orderB?.status).toBe("pending");

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "RF2"));
    expect(refundRows).toHaveLength(0);

    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, fixture.app.id),
          eq(entitlementGrants.sourceType, "order"),
          eq(entitlementGrants.sourceId, fixture.checkout.orderId),
        ),
      );
    expect(grants.every((g) => g.status === "active")).toBe(true);
  });
});

describe("refund reconciliation signals (#128)", () => {
  function paymentPayload(
    fixture: Fixture,
    id: string,
    type: string,
    extra: Record<string, unknown>,
  ) {
    return {
      id,
      type,
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_s128_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1998,
        currency: "USD",
        ...extra,
      },
    };
  }

  it("logs loudly when a new refund fact is clamped to remaining headroom", async () => {
    const fixture = await createFixture("one_time");
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(
        paymentPayload(fixture, "evt_s128_s", "payment.succeeded", {}),
      ),
      db,
    );
    // Consume most headroom first.
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(
        paymentPayload(fixture, "evt_s128_r1", "payment.refunded", {
          provider_refund_id: "RS128_A",
          amount_minor: 1498,
        }),
      ),
      db,
    );

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      // Requests 700 but only 500 headroom remains -> clamped, signaled.
      await processFixtureWebhook(
        fixture,
        (() => {
          const payload = paymentPayload(
            fixture,
            "evt_s128_r2",
            "payment.refunded",
            {
              provider_refund_id: "RS128_B",
              amount_minor: 700,
            },
          );
          return payload;
        })(),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("evt_s128_r2"),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("applied clamped to 500"),
      );
    } finally {
      consoleError.mockRestore();
    }

    const [row] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "RS128_B"))
      .limit(1);
    expect(row?.amountMinor).toBe(500);
  });

  it("logs loudly when a confirmed upgrade exceeds the captured amount", async () => {
    const fixture = await createFixture("one_time");
    await processProviderWebhook(
      fixture.app.id,
      fixture.providerConnection.id,
      webhookInput(
        paymentPayload(fixture, "evt_s128_s2", "payment.succeeded", {}),
      ),
      db,
    );
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, "pay_s128_1"))
      .limit(1);
    if (!payment) throw new Error("payment missing");
    await db.insert(refunds).values({
      id: "ref_s128_pending",
      applicationId: fixture.app.id,
      orderId: fixture.checkout.orderId,
      paymentId: payment.id,
      providerConnectionId: fixture.providerConnection.id,
      providerRefundId: "RS128_C",
      environment: "test",
      status: "pending",
      amountMinor: 2500,
    });

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await processFixtureWebhook(
        fixture,
        paymentPayload(fixture, "evt_s128_r3", "payment.refunded", {
          provider_refund_id: "RS128_C",
          amount_minor: 2500,
        }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("evt_s128_r3"),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("exceeds captured 1998"),
      );
    } finally {
      consoleError.mockRestore();
    }

    // The confirmed fact is booked as-is (uncapped by design).
    const [row] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, "RS128_C"))
      .limit(1);
    expect(row).toMatchObject({ status: "succeeded", amountMinor: 2500 });
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
