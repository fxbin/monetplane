import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import { createCommerceCheckout } from "../../src/modules/commerce/checkout";
import { processProviderWebhook } from "../../src/modules/commerce/webhook";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
import { registerProviderAdapter } from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import { webhookDeliveries } from "../../src/modules/webhooks/schema";
import {
  createWebhookEndpoint,
  listWebhookDeliveries,
  retryWebhookDelivery,
} from "../../src/modules/webhooks/service";
import { publishBillingLifecycleEvent } from "../../src/server/control-plane/billing-events";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  registerProviderAdapter(mockProviderAdapter);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  await getSqlClient().end({ timeout: 1 });
});

async function startReceiver(
  handler: RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/monetplane`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const slug = `dev-events-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1", email: "dev@test" },
    db,
  );
  const product = await createProduct(
    { applicationId: app.id, key: "pro", name: "Pro" },
    db,
  );
  const price = await createPrice(
    {
      applicationId: app.id,
      productId: product.id,
      key: "one-time",
      currency: "USD",
      amountMinor: 2900,
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
      credentials: { webhookSecret: `${slug}-secret` },
    },
    db,
  );
  const { registerCallbackOrigin } = await import(
    "../../src/modules/applications/service"
  );
  await registerCallbackOrigin(app.id, "https://product.test/success", db);
  await registerCallbackOrigin(app.id, "https://product.test/cancel", db);
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
  return { app, customer, checkout, connection };
}

async function succeedPayment(f: Fixture, eventId: string) {
  const rawBody = JSON.stringify({
    id: eventId,
    type: "payment.succeeded",
    occurred_at: new Date().toISOString(),
    data: {
      provider_payment_id: `pay_${eventId}`,
      monetplane_order_id: f.checkout.orderId,
      monetplane_customer_id: f.customer.customerId,
      amount_minor: 2900,
      currency: "USD",
    },
  });
  return processProviderWebhook(
    f.app.id,
    f.connection.id,
    {
      rawBody,
      headers: {
        "x-monetplane-mock-signature": signMockWebhookPayload(
          rawBody,
          `${f.app.slug}-secret`,
        ),
      },
    },
    db,
  );
}

describe("developer event externalCustomerId contract (MP-REV-04)", () => {
  const receivers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of receivers.splice(0)) await close();
  });

  function signedSuccess(
    f: Fixture,
    eventId: string,
    providerCustomerId?: string,
  ) {
    const rawBody = JSON.stringify({
      id: eventId,
      type: "payment.succeeded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: `pay_${eventId}`,
        monetplane_order_id: f.checkout.orderId,
        monetplane_customer_id: f.customer.customerId,
        provider_customer_id: providerCustomerId,
        amount_minor: 2900,
        currency: "USD",
      },
    });
    return processProviderWebhook(
      f.app.id,
      f.connection.id,
      {
        rawBody,
        headers: {
          "x-monetplane-mock-signature": signMockWebhookPayload(
            rawBody,
            `${f.app.slug}-secret`,
          ),
        },
      },
      db,
    );
  }

  it("exposes the application externalCustomerId, never the PSP customer id", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );

    // The provider event carries a PSP-side customer id that differs from
    // both the MonetPlane internal id and the application external id.
    const result = await signedSuccess(f, "evt_xid_1", "cus_psp_9");
    expect(result.status).toBe("processed");
    const published = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: result.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    const delivery = deliveries[deliveries.length - 1];
    expect(published.published).toBe(true);
    // Fixture customer: external id "user-1", internal id f.customer.customerId.
    expect(delivery.externalCustomerId).toBe("user-1");

    // The wire payload must carry the application external id and never
    // leak the PSP customer id.
    const [rawDelivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, delivery.id))
      .limit(1);
    const payloadData = (
      rawDelivery.payload as { data?: Record<string, unknown> }
    ).data;
    expect(payloadData?.externalCustomerId).toBe("user-1");
    expect(JSON.stringify(rawDelivery.payload)).not.toContain("cus_psp_9");
  });

  it("T3: the payments customer fallback never leaks another application's external id (round-3 finding 3)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded", "payment.refunded"],
      },
      db,
    );

    // A second application linked to the SAME global customer with a
    // DIFFERENT external id — the fallback join must stay inside app A.
    const otherApp = await createApplication(
      {
        slug: `t3-other-${Math.random().toString(36).slice(2, 8)}`,
        name: "Other",
      },
      db,
    );
    await createApplicationCustomer(
      {
        applicationId: otherApp.id,
        customerId: f.customer.customerId,
        externalCustomerId: "other-app-user",
        email: "shared@example.test",
      },
      db,
    );

    // Record the payment via a fully-referenced success event...
    const first = await signedSuccess(f, "evt_t3_s", "cus_psp_x");
    expect(first.status).toBe("processed");
    await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: first.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    // ...then a provider-id-only refund: externalCustomerId resolution goes
    // through the payments fallback join.
    const rawBody = JSON.stringify({
      id: "evt_t3_r",
      type: "payment.refunded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_evt_t3_s",
        provider_refund_id: "rt3_1",
        amount_minor: 2900,
        currency: "USD",
      },
    });
    const refund = await processProviderWebhook(
      f.app.id,
      f.connection.id,
      {
        rawBody,
        headers: {
          "x-monetplane-mock-signature": signMockWebhookPayload(
            rawBody,
            `${f.app.slug}-secret`,
          ),
        },
      },
      db,
    );
    expect(refund.status).toBe("processed");
    const published = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: refund.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    expect(published.published).toBe(true);

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    const refundDelivery = deliveries.find(
      (row) => row.eventType === "payment.refunded",
    );
    expect(refundDelivery).toBeDefined();
    expect(refundDelivery?.externalCustomerId).toBe("user-1");
    expect(refundDelivery?.externalCustomerId).not.toBe("other-app-user");
  });

  it("resolves externalCustomerId from the recorded payment when the event carries neither internal reference (§二A)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded", "payment.refunded"],
      },
      db,
    );

    // First event carries the internal references (records the payment with
    // its customer); the PSP-style replay carries ONLY the provider payment
    // id — resolution must go through the recorded payment.
    const first = await signedSuccess(f, "evt_fb_1", "cus_psp_x");
    expect(first.status).toBe("processed");
    await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: first.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    // A refund notification carrying ONLY provider ids (PSPs that do not
    // echo the merchant metadata): resolution must go through the recorded
    // payment row. (A second success event would now be replay-ignored by
    // the B3 guard, so the refund type drives the fallback path.)
    const rawBody = JSON.stringify({
      id: "evt_fb_2",
      type: "payment.refunded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_evt_fb_1",
        provider_refund_id: "rfb_1",
        amount_minor: 2900,
        currency: "USD",
      },
    });
    const second = await processProviderWebhook(
      f.app.id,
      f.connection.id,
      {
        rawBody,
        headers: {
          "x-monetplane-mock-signature": signMockWebhookPayload(
            rawBody,
            `${f.app.slug}-secret`,
          ),
        },
      },
      db,
    );
    expect(second.status).toBe("processed");
    const published = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: second.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    expect(published.published).toBe(true);

    // Assert on THE refund delivery specifically (list is desc by createdAt,
    // so indexing the tail would read the oldest row and pass vacuously —
    // verifier finding).
    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    const refundDelivery = deliveries.find(
      (row) => row.eventType === "payment.refunded",
    );
    expect(refundDelivery).toBeDefined();
    expect(refundDelivery?.externalCustomerId).toBe("user-1");
  });

  function subscriptionEventPayload(
    f: Fixture,
    overrides: {
      id: string;
      type: string;
      subscriptionStatus: string;
      periodStart: string;
      periodEnd: string;
    },
  ) {
    return {
      id: overrides.id,
      type: overrides.type,
      occurred_at: new Date().toISOString(),
      data: {
        provider_subscription_id: "sub_fact_1",
        subscription_status: overrides.subscriptionStatus,
        subscription_period_start: overrides.periodStart,
        subscription_period_end: overrides.periodEnd,
        monetplane_order_id: f.checkout.orderId,
        monetplane_customer_id: f.customer.customerId,
        amount_minor: 2900,
        currency: "USD",
      },
    };
  }

  async function processSigned(f: Fixture, payload: Record<string, unknown>) {
    const rawBody = JSON.stringify(payload);
    return processProviderWebhook(
      f.app.id,
      f.connection.id,
      {
        rawBody,
        headers: {
          "x-monetplane-mock-signature": signMockWebhookPayload(
            rawBody,
            `${f.app.slug}-secret`,
          ),
        },
      },
      db,
    );
  }

  it("same activation fact under two provider event ids delivers exactly once (#131)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: [
          "subscription.activated",
          "subscription.renewed",
          "payment.failed",
        ],
      },
      db,
    );

    const period = {
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
    };
    const first = await processSigned(
      f,
      subscriptionEventPayload(f, {
        id: "evt_fact_a1",
        type: "subscription.activated",
        subscriptionStatus: "active",
        ...period,
      }),
    );
    expect(first.status).toBe("processed");
    await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: first.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    // Same business fact, DIFFERENT provider event id (provider retry churn).
    const second = await processSigned(
      f,
      subscriptionEventPayload(f, {
        id: "evt_fact_a2",
        type: "subscription.activated",
        subscriptionStatus: "active",
        ...period,
      }),
    );
    expect(second.status).toBe("processed");
    const published = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: second.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    expect(published.eventId).toMatch(/^dev_subscription_[0-9a-f]{32}$/);

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    const activations = deliveries.filter(
      (row) => row.eventType === "subscription.activated",
    );
    expect(activations).toHaveLength(1);
  });

  it("payment.failed replays under new event ids deliver exactly once (#131)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      { name: "receiver", url: receiver.url, eventTypes: ["payment.failed"] },
      db,
    );

    const failedPayload = (id: string) => ({
      id,
      type: "payment.failed",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_fact_fail_1",
        monetplane_order_id: f.checkout.orderId,
        monetplane_customer_id: f.customer.customerId,
        amount_minor: 2900,
        currency: "USD",
      },
    });
    const first = await processSigned(f, failedPayload("evt_fact_f1"));
    expect(first.status).toBe("processed");
    await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: first.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    const second = await processSigned(f, failedPayload("evt_fact_f2"));
    expect(second.status).toBe("processed");
    await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: second.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventId).toMatch(/^dev_payment_[0-9a-f]{32}$/);
  });

  it("renewals in different periods remain distinct facts with distinct ids (#131)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["subscription.renewed"],
      },
      db,
    );

    for (const [i, periodStart] of [
      ["2026-10-01T00:00:00.000Z"],
      ["2026-11-01T00:00:00.000Z"],
    ].entries()) {
      const renewed = await processSigned(
        f,
        subscriptionEventPayload(f, {
          id: `evt_fact_r${i}`,
          type: "subscription.renewed",
          subscriptionStatus: "active",
          periodStart: periodStart[0] as string,
          periodEnd: "2026-12-01T00:00:00.000Z",
        }),
      );
      expect(renewed.status).toBe("processed");
      await publishBillingLifecycleEvent({
        applicationId: f.app.id,
        webhookEventId: renewed.webhookEventId,
        providerConnectionId: f.connection.id,
      });
    }

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries).toHaveLength(2);
    const ids = new Set(deliveries.map((row) => row.eventId));
    expect(ids.size).toBe(2);
  });

  it("refund without providerRefundId falls back to the raw inbox id and never collides with succeeded (round-4 P0)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded", "payment.refunded"],
      },
      db,
    );

    const success = await signedSuccess(f, "evt_rn_s");
    expect(success.status).toBe("processed");
    const successPublished = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: success.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    // A refund for the same payment with NO provider_refund_id: the fact id
    // must be the raw inbox fallback — sharing the succeeded fact id would
    // make the delivery uniqueness silently swallow the refund event.
    const refundRaw = JSON.stringify({
      id: "evt_rn_r",
      type: "payment.refunded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_evt_rn_s",
        monetplane_order_id: f.checkout.orderId,
        monetplane_customer_id: f.customer.customerId,
        amount_minor: 500,
        currency: "USD",
      },
    });
    const refund = await processProviderWebhook(
      f.app.id,
      f.connection.id,
      {
        rawBody: refundRaw,
        headers: {
          "x-monetplane-mock-signature": signMockWebhookPayload(
            refundRaw,
            `${f.app.slug}-secret`,
          ),
        },
      },
      db,
    );
    expect(refund.status).toBe("processed");
    const refundPublished = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: refund.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    expect(refundPublished.eventId).toBe(`dev_${refund.webhookEventId}`);
    expect(refundPublished.eventId).not.toBe(successPublished.eventId);

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries).toHaveLength(2);
  });

  it("renewal carrying providerPaymentId stays a subscription-period fact (round-4 P0)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["subscription.renewed"],
      },
      db,
    );

    // Real-adapter shape: renewals carry BOTH the transaction id and the
    // subscription/period references.
    const rawBody = JSON.stringify({
      id: "evt_rw_full",
      type: "subscription.renewed",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_rw_txn_1",
        provider_subscription_id: "sub_rw_1",
        subscription_status: "active",
        subscription_period_start: "2026-10-01T00:00:00.000Z",
        subscription_period_end: "2026-11-01T00:00:00.000Z",
        monetplane_order_id: f.checkout.orderId,
        monetplane_customer_id: f.customer.customerId,
        amount_minor: 2900,
        currency: "USD",
      },
    });
    const renewed = await processProviderWebhook(
      f.app.id,
      f.connection.id,
      {
        rawBody,
        headers: {
          "x-monetplane-mock-signature": signMockWebhookPayload(
            rawBody,
            `${f.app.slug}-secret`,
          ),
        },
      },
      db,
    );
    expect(renewed.status).toBe("processed");
    const published = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: renewed.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    expect(published.eventId).toMatch(/^dev_subscription_[0-9a-f]{32}$/);
    expect(published.eventId).not.toMatch(/^dev_payment_/);
  });

  it("a renewal without period boundaries is rejected by ingest, so the raw-inbox fallback only applies to publishable shapes (round-4)", async () => {
    // The ingest enforces period boundaries on active subscription facts
    // (entitlements need them), so a period-less renewal can never reach the
    // publisher through a successful ingest — the raw-inbox fallback in
    // factBasedDeveloperEventId covers only defensive/late-publish shapes.
    const f: Fixture = await seed();
    const rawBody = JSON.stringify({
      id: "evt_rw_noperiod",
      type: "subscription.renewed",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_rw_txn_2",
        provider_subscription_id: "sub_rw_2",
        subscription_status: "active",
        monetplane_order_id: f.checkout.orderId,
        monetplane_customer_id: f.customer.customerId,
        amount_minor: 2900,
        currency: "USD",
      },
    });
    await expect(
      processProviderWebhook(
        f.app.id,
        f.connection.id,
        {
          rawBody,
          headers: {
            "x-monetplane-mock-signature": signMockWebhookPayload(
              rawBody,
              `${f.app.slug}-secret`,
            ),
          },
        },
        db,
      ),
    ).rejects.toThrow(/period boundaries/);
  });

  it("sanitization cannot merge distinct refund facts: 'rf:a' vs 'rf/a' (round-4 P1)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      { name: "receiver", url: receiver.url, eventTypes: ["payment.refunded"] },
      db,
    );
    await signedSuccess(f, "evt_col_s");

    for (const [i, refundId] of ["rf:a", "rf/a"].entries()) {
      const rawBody = JSON.stringify({
        id: `evt_col_r${i}`,
        type: "payment.refunded",
        occurred_at: new Date().toISOString(),
        data: {
          provider_payment_id: "pay_evt_col_s",
          provider_refund_id: refundId,
          monetplane_order_id: f.checkout.orderId,
          monetplane_customer_id: f.customer.customerId,
          amount_minor: 500,
          currency: "USD",
        },
      });
      const processed = await processProviderWebhook(
        f.app.id,
        f.connection.id,
        {
          rawBody,
          headers: {
            "x-monetplane-mock-signature": signMockWebhookPayload(
              rawBody,
              `${f.app.slug}-secret`,
            ),
          },
        },
        db,
      );
      expect(processed.status).toBe("processed");
      const published = await publishBillingLifecycleEvent({
        applicationId: f.app.id,
        webhookEventId: processed.webhookEventId,
        providerConnectionId: f.connection.id,
      });
      expect(published.eventId).toMatch(/^dev_refund_[0-9a-f]{32}$/);
    }

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    const refundDeliveries = deliveries.filter(
      (row) => row.eventType === "payment.refunded",
    );
    expect(refundDeliveries).toHaveLength(2);
    expect(new Set(refundDeliveries.map((row) => row.eventId)).size).toBe(2);
  });

  it("resolves externalCustomerId from the customer mapping alone when the event has no order id (MP-REV-04)", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );

    // Order-less event: resolution must go through the customer-mapping
    // path (monetplaneCustomerId -> application_customers.external_customer_id),
    // not the order fallback.
    const rawBody = JSON.stringify({
      id: "evt_xid_3",
      type: "payment.succeeded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_evt_xid_3",
        monetplane_customer_id: f.customer.customerId,
        amount_minor: 2900,
        currency: "USD",
      },
    });
    const result = await processProviderWebhook(
      f.app.id,
      f.connection.id,
      {
        rawBody,
        headers: {
          "x-monetplane-mock-signature": signMockWebhookPayload(
            rawBody,
            `${f.app.slug}-secret`,
          ),
        },
      },
      db,
    );
    expect(result.status).toBe("processed");
    const published = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: result.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    expect(published.published).toBe(true);

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries[deliveries.length - 1].externalCustomerId).toBe("user-1");
  });

  it("still resolves externalCustomerId when the event carries no PSP customer id", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );
    const result = await signedSuccess(f, "evt_xid_2");
    expect(result.status).toBe("processed");
    const published = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: result.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    expect(published.published).toBe(true);

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries[deliveries.length - 1].externalCustomerId).toBe("user-1");
  });
});

describe("developer billing lifecycle events (#61)", () => {
  const receivers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of receivers.splice(0)) await close();
  });

  it("fans a committed payment out to matching endpoints as a signed provider-neutral event", async () => {
    const f: Fixture = await seed();
    let receivedBody = "";
    let receivedSignature = "";
    const receiver = await startReceiver((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        receivedBody = body;
        receivedSignature =
          req.headers["x-monetplane-signature"]?.toString() ?? "";
        res.statusCode = 204;
        res.end();
      });
    });
    receivers.push(receiver.close);
    const endpoint = await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );

    const result = await succeedPayment(f, "evt_dev_1");
    expect(result.duplicate).toBe(false);
    const published = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: result.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    expect(published).toMatchObject({
      published: true,
      eventType: "payment.succeeded",
    });

    const payload = JSON.parse(receivedBody);
    // #131: fact-based identity — same payment fact always yields this id.
    expect(payload.id).toMatch(/^dev_payment_[0-9a-f]{32}$/);
    expect(payload.version).toBe(1);
    expect(payload.type).toBe("payment.succeeded");
    expect(payload.data.orderId).toBe(f.checkout.orderId);
    expect(payload.data.environment).toBe("test");
    // No provider secrets or raw provider payloads leak.
    expect(receivedBody).not.toContain(f.app.slug);
    expect(receivedSignature.length).toBeGreaterThan(0);

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries.filter((d) => d.eventId === payload.id)).toHaveLength(1);
    expect(endpoint.id).toBeTruthy();
  });

  it("does not duplicate developer events for replayed provider webhooks", async () => {
    const f: Fixture = await seed();
    const receiver = await startReceiver((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );

    const first = await succeedPayment(f, "evt_dev_dup");
    const publish1 = await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: first.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    const replay = await succeedPayment(f, "evt_dev_dup");
    expect(replay.duplicate).toBe(true);
    // A replayed provider event has no fresh webhook event row to publish.
    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries).toHaveLength(1);
    expect(publish1.eventId).toBeTruthy();
  });

  it("respects endpoint event-type filters for real lifecycle events", async () => {
    const f: Fixture = await seed();
    let hits = 0;
    const receiver = await startReceiver((_req, res) => {
      hits += 1;
      res.statusCode = 204;
      res.end();
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "subscription-only",
        url: receiver.url,
        eventTypes: ["subscription.activated"], // payment events filtered out
      },
      db,
    );

    const result = await succeedPayment(f, "evt_dev_filtered");
    await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: result.webhookEventId,
      providerConnectionId: f.connection.id,
    });
    expect(hits).toBe(0);
  });

  it("keeps failed deliveries visible and retryable through the webhook console", async () => {
    const f: Fixture = await seed();
    let failFirst = true;
    const receiver = await startReceiver((_req, res) => {
      if (failFirst) {
        res.statusCode = 503;
        res.end("boom");
      } else {
        res.statusCode = 204;
        res.end();
      }
    });
    receivers.push(receiver.close);
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: [],
      },
      db,
    );

    const result = await succeedPayment(f, "evt_dev_fail");
    await publishBillingLifecycleEvent({
      applicationId: f.app.id,
      webhookEventId: result.webhookEventId,
      providerConnectionId: f.connection.id,
    });

    let deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("failed");

    failFirst = false;
    const retried = await retryWebhookDelivery(
      f.app.id,
      "test",
      deliveries[0].id,
      {},
      db,
    );
    expect(retried.status).toBe("succeeded");

    deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries[0].status).toBe("succeeded");
  });
});
