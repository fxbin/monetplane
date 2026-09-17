import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  createApplication,
  registerCallbackOrigin,
} from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import { createCommerceCheckout } from "../../src/modules/commerce/checkout";
import { NoProviderRouteError } from "../../src/modules/commerce/router";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
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

async function seed(options: { secondTestConnection?: boolean } = {}) {
  const slug = `router-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  await registerCallbackOrigin(app.id, "https://product.test/success", db);
  await registerCallbackOrigin(app.id, "https://product.test/cancel", db);
  await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      email: "router@test",
    },
    db,
  );
  const testConnection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "sandbox",
      mode: "test",
      credentials: { webhookSecret: `${slug}-test` },
    },
    db,
  );
  await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "production",
      mode: "live",
      credentials: { webhookSecret: `${slug}-live` },
    },
    db,
  );
  let secondTestConnection: string | null = null;
  if (options.secondTestConnection) {
    const second = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "mock",
        name: "sandbox-backup",
        mode: "test",
        credentials: { webhookSecret: `${slug}-test2` },
      },
      db,
    );
    secondTestConnection = second.id;
  }
  const product = await createProduct(
    { applicationId: app.id, key: "pro", name: "Pro" },
    db,
  );
  const oneTimePrice = await createPrice(
    {
      applicationId: app.id,
      productId: product.id,
      key: "one-time",
      currency: "USD",
      amountMinor: 1900,
      billingType: "one_time",
    },
    db,
  );
  const recurringPrice = await createPrice(
    {
      applicationId: app.id,
      productId: product.id,
      key: "monthly",
      currency: "USD",
      amountMinor: 900,
      billingType: "recurring",
      recurringInterval: "month",
    },
    db,
  );
  return {
    app,
    testConnection,
    secondTestConnection,
    product,
    oneTimePrice,
    recurringPrice,
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function checkout(
  f: Fixture,
  priceId: string,
  environment: "test" | "live" = "test",
) {
  return createCommerceCheckout(
    f.app.id,
    {
      externalCustomerId: "user-1",
      items: [{ priceId, quantity: 1 }],
      successUrl: "https://product.test/success",
      cancelUrl: "https://product.test/cancel",
      environment,
    },
    db,
  );
}

describe("payment router v1 (#60)", () => {
  it("routes one-time and recurring checkouts without caller-supplied providerConnectionId", async () => {
    const f: Fixture = await seed();

    const oneTime = await checkout(f, f.oneTimePrice.id);
    expect(oneTime.routing).toMatchObject({
      source: "default",
      provider: "mock",
      environment: "test",
    });

    const recurring = await checkout(f, f.recurringPrice.id);
    expect(recurring.routing.source).toBe("default");
    expect(recurring.orderId).toMatch(/^ord_/);
  });

  it("routes by product providerRouting metadata and cannot cross environments", async () => {
    const f: Fixture = await seed({ secondTestConnection: true });
    const { products } = await import("../../src/modules/catalog/schema");
    await db
      .update(products)
      .set({
        metadata: {
          monetplane: { providerRouting: { test: f.testConnection.id } },
        },
      })
      .where(eq(products.id, f.product.id));

    const routed = await checkout(f, f.oneTimePrice.id);
    expect(routed.routing).toMatchObject({
      source: "product",
      connectionId: f.testConnection.id,
    });

    // Live has no routing metadata and one active connection → default route.
    const live = await checkout(f, f.oneTimePrice.id, "live");
    expect(live.routing.environment).toBe("live");
  });

  it("fails with a provider-neutral error when no route exists", async () => {
    const f: Fixture = await seed({ secondTestConnection: true });
    // Two active sandbox connections without product routing = ambiguous.
    await expect(checkout(f, f.oneTimePrice.id)).rejects.toThrow(
      NoProviderRouteError,
    );
    await expect(checkout(f, f.oneTimePrice.id)).rejects.toThrow(
      /multiple payment providers/i,
    );
  });

  it("rejects revoked or wrong-environment providers before provider invocation", async () => {
    const f: Fixture = await seed();
    const { revokeProviderConnection } = await import(
      "../../src/modules/providers/service"
    );
    await revokeProviderConnection(f.app.id, f.testConnection.id, db);

    await expect(checkout(f, f.oneTimePrice.id)).rejects.toThrow(
      /no active payment provider/i,
    );
  });

  it("keeps the explicit provider override for trusted internal paths", async () => {
    const f: Fixture = await seed();
    const result = await createCommerceCheckout(
      f.app.id,
      {
        externalCustomerId: "user-1",
        providerConnectionId: f.testConnection.id,
        items: [{ priceId: f.oneTimePrice.id, quantity: 1 }],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      },
      db,
    );
    expect(result.routing?.source).toBe("explicit");
  });
});
