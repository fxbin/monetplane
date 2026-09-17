import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import { createCommerceCheckout } from "../../src/modules/commerce/checkout";
import {
  creditAccounts,
  creditTransactions,
} from "../../src/modules/credits/schema";
import {
  debitCredits,
  getCreditBalance,
  grantCredits,
} from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  grantEntitlement,
  hasEntitlement,
} from "../../src/modules/entitlements/service";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import { registerProviderAdapter } from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import { getUsageAnalytics } from "../../src/server/control-plane/overview";

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

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const slug = `env-iso-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      email: "env-iso@test",
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
  const liveConnection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "production",
      mode: "live",
      credentials: { webhookSecret: `${slug}-live` },
    },
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
      amountMinor: 1900,
      billingType: "one_time",
    },
    db,
  );
  return { app, testConnection, liveConnection, product, price };
}

describe("environment isolation (#74)", () => {
  it("keeps credit balances, idempotency keys, and usage independent per environment", async () => {
    const f: Fixture = await seed();

    await grantCredits(
      {
        applicationId: f.app.id,
        applicationCustomerId: await resolveCustomerId(f.app.id),
        creditType: "agent.run",
        amount: 100,
        transactionType: "grant.promotion",
        sourceType: "test",
        sourceId: "seed",
        idempotencyKey: "same-key",
        environment: "test",
      },
      db,
    );

    // Same idempotency key in live is a separate, valid mutation.
    await grantCredits(
      {
        applicationId: f.app.id,
        applicationCustomerId: await resolveCustomerId(f.app.id),
        creditType: "agent.run",
        amount: 50,
        transactionType: "grant.promotion",
        sourceType: "test",
        sourceId: "seed-live",
        idempotencyKey: "same-key",
        environment: "live",
      },
      db,
    );

    // Sandbox debit must not touch the Production balance.
    await expect(
      debitCredits(
        {
          applicationId: f.app.id,
          externalCustomerId: "user-1",
          creditType: "agent.run",
          amount: 60,
          sourceType: "usage",
          sourceId: "job-1",
          idempotencyKey: "debit-sandbox",
          environment: "test",
        },
        db,
      ),
    ).resolves.toBeTruthy();

    const testBalance = await getCreditBalance(
      f.app.id,
      "user-1",
      "agent.run",
      db,
      "test",
    );
    const liveBalance = await getCreditBalance(
      f.app.id,
      "user-1",
      "agent.run",
      db,
      "live",
    );
    expect(testBalance.available).toBe(40);
    expect(liveBalance.available).toBe(50);

    // Accounts are split per environment.
    const accounts = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.applicationId, f.app.id));
    expect(accounts.map((a) => a.environment).sort()).toEqual(["live", "test"]);

    // Usage analytics are environment-scoped.
    const testUsage = await getUsageAnalytics(f.app.id, "test");
    const liveUsage = await getUsageAnalytics(f.app.id, "live");
    expect(testUsage.byCreditType[0]?.granted).toBe(100);
    expect(liveUsage.byCreditType[0]?.granted).toBe(50);

    // The same idempotency key exists once per environment.
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationId, f.app.id));
    expect(txRows.filter((t) => t.idempotencyKey === "same-key")).toHaveLength(
      2,
    );
  });

  it("fails closed when checkout requests a different environment than the provider connection", async () => {
    const f: Fixture = await seed();
    await registerCallbackOriginForApp(f.app.id);

    await expect(
      createCommerceCheckout(
        f.app.id,
        {
          externalCustomerId: "user-1",
          providerConnectionId: f.testConnection.id,
          items: [{ priceId: f.price.id, quantity: 1 }],
          successUrl: "https://product.test/success",
          cancelUrl: "https://product.test/cancel",
          environment: "live",
        },
        db,
      ),
    ).rejects.toThrow(/does not belong to the requested environment/i);

    // Matching environment proceeds.
    const checkout = await createCommerceCheckout(
      f.app.id,
      {
        externalCustomerId: "user-1",
        providerConnectionId: f.liveConnection.id,
        items: [{ priceId: f.price.id, quantity: 1 }],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
        environment: "live",
      },
      db,
    );
    expect(checkout.orderId).toMatch(/^ord_/);
  });

  it("isolates entitlements per environment with shared customer identity", async () => {
    const f: Fixture = await seed();
    const applicationCustomerId = await resolveCustomerId(f.app.id);

    await grantEntitlement(
      {
        applicationId: f.app.id,
        applicationCustomerId,
        featureKey: "pro.features",
        sourceType: "admin",
        sourceId: "seed-admin",
        idempotencyKey: "ent-live",
        validFrom: new Date(),
        environment: "live",
      },
      db,
    );

    expect(
      await hasEntitlement(
        f.app.id,
        "user-1",
        "pro.features",
        new Date(),
        db,
        "live",
      ),
    ).toBe(true);
    expect(
      await hasEntitlement(
        f.app.id,
        "user-1",
        "pro.features",
        new Date(),
        db,
        "test",
      ),
    ).toBe(false);
  });

  it("marks runtime rows with the provider connection environment at checkout", async () => {
    const f: Fixture = await seed();
    await registerCallbackOriginForApp(f.app.id);

    const [orders, sessions] = await Promise.all([
      import("../../src/modules/commerce/schema").then((m) => m.orders),
      import("../../src/modules/commerce/schema").then(
        (m) => m.checkoutSessions,
      ),
    ]);
    const live = await createCommerceCheckout(
      f.app.id,
      {
        externalCustomerId: "user-1",
        providerConnectionId: f.liveConnection.id,
        items: [{ priceId: f.price.id, quantity: 1 }],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      },
      db,
    );
    const test = await createCommerceCheckout(
      f.app.id,
      {
        externalCustomerId: "user-1",
        providerConnectionId: f.testConnection.id,
        items: [{ priceId: f.price.id, quantity: 1 }],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      },
      db,
    );

    const liveOrder = await db
      .select()
      .from(orders)
      .where(eq(orders.id, live.orderId))
      .limit(1);
    const testOrder = await db
      .select()
      .from(orders)
      .where(eq(orders.id, test.orderId))
      .limit(1);
    expect(liveOrder[0]?.environment).toBe("live");
    expect(testOrder[0]?.environment).toBe("test");

    const session = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, test.checkoutSessionId))
      .limit(1);
    expect(session[0]?.environment).toBe("test");
  });
});

async function resolveCustomerId(applicationId: string): Promise<string> {
  const { applicationCustomers } = await import(
    "../../src/modules/customers/schema"
  );
  const { and, eq: eqOp } = await import("drizzle-orm");
  const [row] = await db
    .select({ id: applicationCustomers.id })
    .from(applicationCustomers)
    .where(
      and(
        eqOp(applicationCustomers.applicationId, applicationId),
        eqOp(applicationCustomers.externalCustomerId, "user-1"),
      ),
    )
    .limit(1);
  if (!row) throw new Error("seed customer missing");
  return row.id;
}

async function registerCallbackOriginForApp(applicationId: string) {
  const { registerCallbackOrigin } = await import(
    "../../src/modules/applications/service"
  );
  await registerCallbackOrigin(
    applicationId,
    "https://product.test/success",
    db,
  );
  await registerCallbackOrigin(
    applicationId,
    "https://product.test/cancel",
    db,
  );
}
