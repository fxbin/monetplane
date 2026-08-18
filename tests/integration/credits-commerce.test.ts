import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
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
import { processProviderWebhook } from "../../src/modules/commerce/webhook";
import { creditTransactions } from "../../src/modules/credits/schema";
import { getCreditBalance } from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
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

async function createFixture(mode: "one_time" | "subscription") {
  const suffix = Math.random().toString(36).slice(2, 8);
  const app = await createApplication(
    { slug: `credit-pay-${mode.replace("_", "-")}-${suffix}`, name: "Credit Pay" },
    db,
  );
  await registerCallbackOrigin(app.id, "https://credits.test/success", db);
  await registerCallbackOrigin(app.id, "https://credits.test/cancel", db);

  const applicationCustomer = await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      email: `${suffix}@credit-pay.test`,
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
      grantType: "credit",
      referenceKey: "agent.run",
      quantity: mode === "one_time" ? 50 : 30,
    },
    db,
  );

  const price = await createPrice(
    mode === "one_time"
      ? {
          applicationId: app.id,
          productId: product.id,
          key: "credits-pack",
          currency: "USD",
          amountMinor: 2500,
          billingType: "one_time",
        }
      : {
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
  const providerConnection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "primary",
      mode: "test",
      credentials: { webhookSecret: "credit-commerce-secret" },
    },
    db,
  );
  const checkout = await createCommerceCheckout(
    app.id,
    {
      externalCustomerId: "user-1",
      providerConnectionId: providerConnection.id,
      items: [{ priceId: price.id, quantity: mode === "one_time" ? 2 : 1 }],
      successUrl: "https://credits.test/success",
      cancelUrl: "https://credits.test/cancel",
    },
    db,
  );

  return {
    app,
    applicationCustomer,
    providerConnection,
    checkout,
  };
}

function webhookInput(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    headers: {
      "x-monetplane-mock-signature": signMockWebhookPayload(
        rawBody,
        "credit-commerce-secret",
      ),
    },
  };
}

async function processWebhook(
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

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  clearProviderAdaptersForTests();
  registerProviderAdapter(mockProviderAdapter);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

describe("commerce credit grants", () => {
  it("grants one-time purchase credits exactly once and multiplies product quantity", async () => {
    const fixture = await createFixture("one_time");
    const event = {
      id: "evt_credit_purchase",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T15:00:00.000Z",
      data: {
        provider_payment_id: "pay_credit_purchase",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 5000,
        currency: "USD",
      },
    };

    await Promise.all([
      processWebhook(fixture, event),
      processWebhook(fixture, event),
    ]);

    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 100, reserved: 0 });
    const grants = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationId, fixture.app.id));
    expect(grants.filter((transaction) => transaction.type === "grant.purchase")).toHaveLength(
      1,
    );
    expect(grants.find((transaction) => transaction.type === "grant.purchase")?.amount).toBe(
      100,
    );
  });

  it("grants each paid subscription period once and never grants a failed renewal", async () => {
    const fixture = await createFixture("subscription");
    const baseData = {
      provider_subscription_id: "sub_credit_1",
      monetplane_order_id: fixture.checkout.orderId,
      monetplane_customer_id: fixture.applicationCustomer.customerId,
    };

    await processWebhook(fixture, {
      id: "evt_credit_active",
      type: "subscription.activated",
      occurred_at: "2026-08-18T15:10:00.000Z",
      data: {
        ...baseData,
        subscription_status: "active",
        subscription_period_start: "2026-08-18T00:00:00.000Z",
        subscription_period_end: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 30, reserved: 0 });

    await processWebhook(fixture, {
      id: "evt_credit_failed",
      type: "payment.failed",
      occurred_at: "2026-09-18T00:01:00.000Z",
      data: {
        provider_payment_id: "pay_credit_failed",
        provider_subscription_id: "sub_credit_1",
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1900,
        currency: "USD",
      },
    });
    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 30, reserved: 0 });

    const renewal = {
      id: "evt_credit_renewal",
      type: "subscription.renewed",
      occurred_at: "2026-09-19T00:00:00.000Z",
      data: {
        ...baseData,
        subscription_status: "active",
        subscription_period_start: "2026-09-18T00:00:00.000Z",
        subscription_period_end: "2026-10-18T00:00:00.000Z",
      },
    };
    await processWebhook(fixture, renewal);
    await processWebhook(fixture, renewal);

    await processWebhook(fixture, {
      id: "evt_credit_updated",
      type: "subscription.updated",
      occurred_at: "2026-09-20T00:00:00.000Z",
      data: renewal.data,
    });

    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 60, reserved: 0 });
    const grants = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationId, fixture.app.id));
    expect(
      grants.filter((transaction) => transaction.type === "grant.subscription"),
    ).toHaveLength(2);
  });
});
