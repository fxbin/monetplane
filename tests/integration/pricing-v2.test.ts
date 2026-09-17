import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  createApplication,
  registerCallbackOrigin,
} from "../../src/modules/applications/service";
import { prices } from "../../src/modules/catalog/schema";
import {
  archivePrice,
  createPrice,
  createProduct,
} from "../../src/modules/catalog/service";
import { createCommerceCheckout } from "../../src/modules/commerce/checkout";
import {
  orderItems,
  subscriptionItems,
} from "../../src/modules/commerce/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  MOCK_CAPABILITIES,
  mockProviderAdapter,
} from "../../src/modules/providers/adapters/mock";
import { registerProviderAdapter } from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";

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

async function seed() {
  const slug = `pricing-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  await registerCallbackOrigin(app.id, "https://product.test/success", db);
  await registerCallbackOrigin(app.id, "https://product.test/cancel", db);
  await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1", email: "p@test" },
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
  const product = await createProduct(
    { applicationId: app.id, key: "weekly-pro", name: "Weekly Pro" },
    db,
  );
  return { app, connection, product };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

describe("pricing model v2 (#64)", () => {
  it("represents weekly recurring prices with provider-neutral trials in the core catalog", async () => {
    const f: Fixture = await seed();
    const weekly = await createPrice(
      {
        applicationId: f.app.id,
        productId: f.product.id,
        key: "weekly-trial",
        currency: "USD",
        amountMinor: 499,
        billingType: "recurring",
        recurringInterval: "week",
        trialPeriodDays: 7,
      },
      db,
    );
    expect(weekly.recurringInterval).toBe("week");
    expect(weekly.trialPeriodDays).toBe(7);
    expect(weekly.status).toBe("active");

    // Trial on a one-time price is rejected.
    await expect(
      createPrice(
        {
          applicationId: f.app.id,
          productId: f.product.id,
          key: "bad-trial",
          currency: "USD",
          amountMinor: 100,
          billingType: "one_time",
          trialPeriodDays: 7,
        },
        db,
      ),
    ).rejects.toThrow(/trial periods require a recurring price/i);

    // Monthly/yearly compatibility unchanged.
    const monthly = await createPrice(
      {
        applicationId: f.app.id,
        productId: f.product.id,
        key: "monthly",
        currency: "USD",
        amountMinor: 1900,
        billingType: "recurring",
        recurringInterval: "month",
      },
      db,
    );
    expect(monthly.recurringInterval).toBe("month");
  });

  it("checks weekly and trial capabilities before provider invocation", async () => {
    const f: Fixture = await seed();
    const { clearProviderAdaptersForTests } = await import(
      "../../src/modules/providers/registry"
    );
    const limitedAdapter = {
      ...mockProviderAdapter,
      provider: "limited",
      getCapabilities: () => ({
        ...MOCK_CAPABILITIES,
        weekly_interval: false,
        trial_periods: false,
      }),
    };
    clearProviderAdaptersForTests();
    registerProviderAdapter(limitedAdapter);
    const limitedConnection = await createProviderConnection(
      {
        applicationId: f.app.id,
        provider: "limited",
        name: "limited",
        mode: "test",
        credentials: { webhookSecret: `${f.app.slug}-limited` },
      },
      db,
    );
    const weekly = await createPrice(
      {
        applicationId: f.app.id,
        productId: f.product.id,
        key: "weekly",
        currency: "USD",
        amountMinor: 499,
        billingType: "recurring",
        recurringInterval: "week",
      },
      db,
    );
    await expect(
      createCommerceCheckout(
        f.app.id,
        {
          externalCustomerId: "user-1",
          providerConnectionId: limitedConnection.id,
          items: [{ priceId: weekly.id, quantity: 1 }],
          successUrl: "https://product.test/success",
          cancelUrl: "https://product.test/cancel",
        },
        db,
      ),
    ).rejects.toThrow(/week/i);

    const trialPrice = await createPrice(
      {
        applicationId: f.app.id,
        productId: f.product.id,
        key: "monthly-trial",
        currency: "USD",
        amountMinor: 1900,
        billingType: "recurring",
        recurringInterval: "month",
        trialPeriodDays: 14,
      },
      db,
    );
    await expect(
      createCommerceCheckout(
        f.app.id,
        {
          externalCustomerId: "user-1",
          providerConnectionId: limitedConnection.id,
          items: [{ priceId: trialPrice.id, quantity: 1 }],
          successUrl: "https://product.test/success",
          cancelUrl: "https://product.test/cancel",
        },
        db,
      ),
    ).rejects.toThrow(/trial/i);

    // Mock adapter declares both capabilities — explicit path checkout works.
    registerProviderAdapter(mockProviderAdapter);
    const routed = await createCommerceCheckout(
      f.app.id,
      {
        externalCustomerId: "user-1",
        providerConnectionId: f.connection.id,
        items: [{ priceId: weekly.id, quantity: 1 }],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      },
      db,
    );
    expect(routed.routing.provider).toBe("mock");
  });

  it("archives prices: unavailable for new checkout, references preserved", async () => {
    const f: Fixture = await seed();
    const price = await createPrice(
      {
        applicationId: f.app.id,
        productId: f.product.id,
        key: "legacy",
        currency: "USD",
        amountMinor: 2900,
        billingType: "one_time",
      },
      db,
    );
    const first = await createCommerceCheckout(
      f.app.id,
      {
        externalCustomerId: "user-1",
        items: [{ priceId: price.id, quantity: 1 }],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      },
      db,
    );
    expect(first.orderId).toBeTruthy();

    const archived = await archivePrice(
      { applicationId: f.app.id, productId: f.product.id, priceId: price.id },
      db,
    );
    expect(archived.status).toBe("archived");
    await expect(
      archivePrice(
        { applicationId: f.app.id, productId: f.product.id, priceId: price.id },
        db,
      ),
    ).rejects.toThrow(/active price not found/i);

    await expect(
      createCommerceCheckout(
        f.app.id,
        {
          externalCustomerId: "user-1",
          items: [{ priceId: price.id, quantity: 1 }],
          successUrl: "https://product.test/success",
          cancelUrl: "https://product.test/cancel",
        },
        db,
      ),
    ).rejects.toThrow(/inactive|no longer available/i);

    // Existing order keeps its historical line-item terms.
    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, first.orderId));
    expect(items[0]?.unitAmountMinor).toBe(2900);
    const [priceRow] = await db
      .select()
      .from(prices)
      .where(eq(prices.id, price.id));
    expect(priceRow.amountMinor).toBe(2900);
  });

  it("snapshots commercial terms on subscription items at creation", async () => {
    const f: Fixture = await seed();
    const weekly = await createPrice(
      {
        applicationId: f.app.id,
        productId: f.product.id,
        key: "weekly-snap",
        currency: "USD",
        amountMinor: 499,
        billingType: "recurring",
        recurringInterval: "week",
        trialPeriodDays: 3,
      },
      db,
    );
    // Simulate a subscription created under these terms (webhook path
    // writes the snapshot; here we verify the storage contract directly).
    const { subscriptions } = await import("../../src/modules/commerce/schema");
    const [subscription] = await db
      .insert(subscriptions)
      .values({
        id: "sub_pricing_snapshot",
        applicationId: f.app.id,
        applicationCustomerId: (
          await db
            .select({
              id: (
                await import("../../src/modules/customers/schema")
              ).applicationCustomers.id,
            })
            .from(
              (
                await import("../../src/modules/customers/schema")
              ).applicationCustomers,
            )
            .where(
              eq(
                (
                  await import("../../src/modules/customers/schema")
                ).applicationCustomers.applicationId,
                f.app.id,
              ),
            )
            .limit(1)
        )[0].id,
        providerConnectionId: f.connection.id,
        providerSubscriptionId: "ps_pricing_snapshot",
        status: "active",
        environment: "test",
      })
      .returning();
    await db.insert(subscriptionItems).values({
      id: "subitem_pricing_snapshot",
      subscriptionId: subscription.id,
      productId: f.product.id,
      priceId: weekly.id,
      quantity: 1,
      unitAmountMinor: 499,
      currency: "USD",
      recurringInterval: "week",
      trialPeriodDays: 3,
    });

    // Archiving the price later must not mutate the subscription terms.
    await archivePrice(
      { applicationId: f.app.id, productId: f.product.id, priceId: weekly.id },
      db,
    );
    const [snapshotted] = await db
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscription.id));
    expect(snapshotted.unitAmountMinor).toBe(499);
    expect(snapshotted.recurringInterval).toBe("week");
    expect(snapshotted.trialPeriodDays).toBe(3);
  });
});
