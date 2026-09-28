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
        eventTypes: ["payment.succeeded", "payment.refunded"],
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
        eventTypes: ["payment.succeeded"],
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

    const deliveries = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(deliveries[deliveries.length - 1].externalCustomerId).toBe("user-1");
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
    expect(payload.id).toMatch(/^dev_wh_/);
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
