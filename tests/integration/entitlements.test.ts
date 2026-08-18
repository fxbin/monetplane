import { and, eq } from "drizzle-orm";
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
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { entitlementGrants } from "../../src/modules/entitlements/schema";
import { hasEntitlement } from "../../src/modules/entitlements/service";
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
    { slug: `ent-${mode.replace("_", "-")}-${suffix}`, name: "Entitlements" },
    db,
  );
  await registerCallbackOrigin(app.id, "https://ent.test/success", db);
  await registerCallbackOrigin(app.id, "https://ent.test/cancel", db);

  const applicationCustomer = await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      email: "entitlement@example.com",
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
  const price = await createPrice(
    mode === "one_time"
      ? {
          applicationId: app.id,
          productId: product.id,
          key: "lifetime",
          currency: "USD",
          amountMinor: 9900,
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
      credentials: { webhookSecret: "entitlement-secret" },
    },
    db,
  );
  const checkout = await createCommerceCheckout(
    app.id,
    {
      externalCustomerId: "user-1",
      providerConnectionId: providerConnection.id,
      items: [{ priceId: price.id, quantity: 1 }],
      successUrl: "https://ent.test/success",
      cancelUrl: "https://ent.test/cancel",
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

function webhookInput(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    headers: {
      "x-monetplane-mock-signature": signMockWebhookPayload(
        rawBody,
        "entitlement-secret",
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

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  clearProviderAdaptersForTests();
  registerProviderAdapter(mockProviderAdapter);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

describe("entitlement grants", () => {
  it("grants durable one-time access once, isolates it, and revokes it on refund", async () => {
    const fixture = await createFixture("one_time");
    const paidEvent = {
      id: "evt_ent_paid",
      type: "payment.succeeded",
      occurred_at: "2026-08-18T14:00:00.000Z",
      data: {
        provider_payment_id: "pay_ent_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 9900,
        currency: "USD",
      },
    };

    await Promise.all([
      processWebhook(fixture, paidEvent),
      processWebhook(fixture, paidEvent),
    ]);

    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(eq(entitlementGrants.applicationId, fixture.app.id));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.sourceType).toBe("order");
    expect(grants[0]?.sourceId).toBe(fixture.checkout.orderId);
    expect(grants[0]?.validUntil).toBeNull();
    expect(
      await hasEntitlement(
        fixture.app.id,
        "user-1",
        "feature.pro",
        new Date("2035-01-01T00:00:00.000Z"),
        db,
      ),
    ).toBe(true);

    const other = await createApplication(
      { slug: "ent-other", name: "Other" },
      db,
    );
    expect(
      await hasEntitlement(other.id, "user-1", "feature.pro", new Date(), db),
    ).toBe(false);

    await processWebhook(fixture, {
      id: "evt_ent_refund",
      type: "payment.refunded",
      occurred_at: "2026-08-19T14:00:00.000Z",
      data: {
        provider_payment_id: "pay_ent_1",
        provider_refund_id: "refund_ent_1",
        monetplane_order_id: fixture.checkout.orderId,
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 9900,
        currency: "USD",
      },
    });

    expect(
      await hasEntitlement(
        fixture.app.id,
        "user-1",
        "feature.pro",
        new Date("2026-08-20T00:00:00.000Z"),
        db,
      ),
    ).toBe(false);
    const [revoked] = await db
      .select()
      .from(entitlementGrants)
      .where(eq(entitlementGrants.applicationId, fixture.app.id))
      .limit(1);
    expect(revoked?.status).toBe("revoked");
  });

  it("creates one time-bounded grant per paid subscription period and no grant for failed renewal", async () => {
    const fixture = await createFixture("subscription");
    const baseData = {
      provider_subscription_id: "sub_ent_1",
      monetplane_order_id: fixture.checkout.orderId,
      monetplane_customer_id: fixture.applicationCustomer.customerId,
    };

    await processWebhook(fixture, {
      id: "evt_ent_active",
      type: "subscription.activated",
      occurred_at: "2026-08-18T14:10:00.000Z",
      data: {
        ...baseData,
        subscription_status: "active",
        subscription_period_start: "2026-08-18T00:00:00.000Z",
        subscription_period_end: "2026-09-18T00:00:00.000Z",
      },
    });

    expect(
      await hasEntitlement(
        fixture.app.id,
        "user-1",
        "feature.pro",
        new Date("2026-09-01T00:00:00.000Z"),
        db,
      ),
    ).toBe(true);
    expect(
      await hasEntitlement(
        fixture.app.id,
        "user-1",
        "feature.pro",
        new Date("2026-09-18T00:00:00.000Z"),
        db,
      ),
    ).toBe(false);

    await processWebhook(fixture, {
      id: "evt_ent_failed",
      type: "payment.failed",
      occurred_at: "2026-09-18T00:01:00.000Z",
      data: {
        provider_payment_id: "pay_ent_failed",
        provider_subscription_id: "sub_ent_1",
        monetplane_customer_id: fixture.applicationCustomer.customerId,
        amount_minor: 1900,
        currency: "USD",
      },
    });

    expect(
      await db
        .select()
        .from(entitlementGrants)
        .where(eq(entitlementGrants.applicationId, fixture.app.id)),
    ).toHaveLength(1);

    const renewal = {
      id: "evt_ent_renewed",
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

    const grants = await db
      .select()
      .from(entitlementGrants)
      .where(eq(entitlementGrants.applicationId, fixture.app.id));
    expect(grants).toHaveLength(2);
    expect(
      await hasEntitlement(
        fixture.app.id,
        "user-1",
        "feature.pro",
        new Date("2026-10-01T00:00:00.000Z"),
        db,
      ),
    ).toBe(true);
  });

  it("revokes immediately cancelled subscriptions and expires terminal subscriptions", async () => {
    const fixture = await createFixture("subscription");
    const baseData = {
      provider_subscription_id: "sub_ent_terminal",
      monetplane_order_id: fixture.checkout.orderId,
      monetplane_customer_id: fixture.applicationCustomer.customerId,
      subscription_period_start: "2026-08-18T00:00:00.000Z",
      subscription_period_end: "2026-09-18T00:00:00.000Z",
    };

    await processWebhook(fixture, {
      id: "evt_ent_terminal_active",
      type: "subscription.activated",
      occurred_at: "2026-08-18T14:20:00.000Z",
      data: { ...baseData, subscription_status: "active" },
    });
    await processWebhook(fixture, {
      id: "evt_ent_terminal_cancel",
      type: "subscription.cancelled",
      occurred_at: "2026-08-20T00:00:00.000Z",
      data: { ...baseData, cancel_at_period_end: false },
    });

    expect(
      await hasEntitlement(
        fixture.app.id,
        "user-1",
        "feature.pro",
        new Date("2026-08-21T00:00:00.000Z"),
        db,
      ),
    ).toBe(false);

    const activeAgain = await createFixture("subscription");
    const secondData = {
      provider_subscription_id: "sub_ent_expire",
      monetplane_order_id: activeAgain.checkout.orderId,
      monetplane_customer_id: activeAgain.applicationCustomer.customerId,
      subscription_period_start: "2026-08-18T00:00:00.000Z",
      subscription_period_end: "2026-09-18T00:00:00.000Z",
    };
    await processWebhook(activeAgain, {
      id: "evt_ent_expire_active",
      type: "subscription.activated",
      occurred_at: "2026-08-18T14:30:00.000Z",
      data: { ...secondData, subscription_status: "active" },
    });
    await processWebhook(activeAgain, {
      id: "evt_ent_expire_terminal",
      type: "subscription.expired",
      occurred_at: "2026-09-18T00:00:01.000Z",
      data: secondData,
    });

    const [expired] = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.applicationId, activeAgain.app.id),
          eq(entitlementGrants.featureKey, "feature.pro"),
        ),
      )
      .limit(1);
    expect(expired?.status).toBe("expired");
  });
});
