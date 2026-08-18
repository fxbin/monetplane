import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
import { InvalidProviderWebhookSignatureError } from "../../src/modules/providers/contract";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import {
  createProviderCheckout,
  verifyAndNormalizeProviderWebhook,
} from "../../src/modules/providers/runtime";
import { providerConnections } from "../../src/modules/providers/schema";
import {
  createProviderConnection,
  getProviderConnection,
  loadProviderConnectionContext,
} from "../../src/modules/providers/service";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  clearProviderAdaptersForTests();
  registerProviderAdapter(mockProviderAdapter);
  await db.delete(applications);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

describe("provider runtime", () => {
  it("persists encrypted credentials and redacts them from service views", async () => {
    const app = await createApplication(
      { slug: "provider-secrets", name: "Provider Secrets" },
      db,
    );
    const view = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "mock",
        name: "primary",
        mode: "test",
        credentials: {
          apiKey: "plain-api-secret",
          webhookSecret: "plain-webhook-secret",
        },
      },
      db,
    );

    expect(view).not.toHaveProperty("encryptedCredentials");
    expect(view).not.toHaveProperty("credentials");

    const [stored] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, view.id))
      .limit(1);

    expect(stored?.encryptedCredentials).toMatch(/^v1:/);
    expect(stored?.encryptedCredentials).not.toContain("plain-api-secret");
    expect(stored?.encryptedCredentials).not.toContain("plain-webhook-secret");

    await expect(
      loadProviderConnectionContext(app.id, view.id, db),
    ).resolves.toMatchObject({
      applicationId: app.id,
      provider: "mock",
      credentials: {
        apiKey: "plain-api-secret",
        webhookSecret: "plain-webhook-secret",
      },
    });
  });

  it("scopes provider connection lookup to the owning application", async () => {
    const firstApp = await createApplication(
      { slug: "provider-a", name: "Provider A" },
      db,
    );
    const secondApp = await createApplication(
      { slug: "provider-b", name: "Provider B" },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: firstApp.id,
        provider: "mock",
        name: "primary",
        mode: "test",
        credentials: { webhookSecret: "secret" },
      },
      db,
    );

    await expect(
      getProviderConnection(secondApp.id, connection.id, db),
    ).resolves.toBeNull();
    await expect(
      loadProviderConnectionContext(secondApp.id, connection.id, db),
    ).rejects.toThrow("not found");
  });

  it("runs checkout and webhook normalization through the registered adapter", async () => {
    const app = await createApplication(
      { slug: "provider-runtime", name: "Provider Runtime" },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "mock",
        name: "primary",
        mode: "test",
        credentials: { webhookSecret: "runtime-secret" },
      },
      db,
    );

    const checkout = await createProviderCheckout(
      app.id,
      connection.id,
      {
        applicationId: app.id,
        monetplaneOrderId: "ord_runtime_1",
        monetplaneCustomerId: "cus_runtime_1",
        billingMode: "subscription",
        interval: "month",
        currency: "USD",
        items: [
          {
            productId: "prod_runtime",
            priceId: "price_runtime",
            quantity: 1,
            unitAmountMinor: 1900,
          },
        ],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      },
      db,
    );

    expect(checkout.providerCheckoutId).toMatch(/^mock_checkout_/);

    const rawBody = JSON.stringify({
      id: "evt_runtime_1",
      type: "subscription.activated",
      occurred_at: "2026-08-18T12:00:00.000Z",
      data: {
        provider_subscription_id: "sub_runtime_1",
        monetplane_order_id: "ord_runtime_1",
        monetplane_customer_id: "cus_runtime_1",
      },
    });
    const signature = signMockWebhookPayload(rawBody, "runtime-secret");

    await expect(
      verifyAndNormalizeProviderWebhook(
        app.id,
        connection.id,
        {
          rawBody,
          headers: { "x-monetplane-mock-signature": signature },
        },
        db,
      ),
    ).resolves.toMatchObject({
      provider: "mock",
      providerEventId: "evt_runtime_1",
      type: "subscription.activated",
      applicationId: app.id,
      monetplaneOrderId: "ord_runtime_1",
    });
  });

  it("rejects invalid webhook signatures before any normalized event exists", async () => {
    const app = await createApplication(
      { slug: "provider-webhook", name: "Provider Webhook" },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "mock",
        name: "primary",
        mode: "test",
        credentials: { webhookSecret: "correct-secret" },
      },
      db,
    );

    await expect(
      verifyAndNormalizeProviderWebhook(
        app.id,
        connection.id,
        {
          rawBody: "{not-json",
          headers: { "x-monetplane-mock-signature": "00" },
        },
        db,
      ),
    ).rejects.toBeInstanceOf(InvalidProviderWebhookSignatureError);
  });
});
