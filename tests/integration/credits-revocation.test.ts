import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
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
import { revokeSubscriptionCredits } from "../../src/modules/credits/revocation";
import {
  creditAccounts,
  creditTransactions,
} from "../../src/modules/credits/schema";
import { reserveCredits } from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
import { registerProviderAdapter } from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import { setupIntegrationFile } from "./test-setup";

/**
 * Subscription credit clawback (roundtable 2026-10-06, PR-C):
 * cancellation revokes the cycle's unused credits as grant.revoked —
 * strictly separate from grant.expired — bounded by available balance so
 * the bucket invariant holds even with an open reservation.
 */
process.env.MONETPLANE_ENCRYPTION_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
registerProviderAdapter(mockProviderAdapter);

const db = getDb();
setupIntegrationFile();

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  await getSqlClient().end({ timeout: 1 });
});

async function seed(prefix: string) {
  const slug = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  await registerCallbackOrigin(app.id, "https://x.test/success", db);
  await registerCallbackOrigin(app.id, "https://x.test/cancel", db);
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "u1" },
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
      referenceKey: "tokens",
      quantity: 100,
    },
    db,
  );
  const price = await createPrice(
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
  const checkout = await createCommerceCheckout(
    app.id,
    {
      externalCustomerId: "u1",
      providerConnectionId: connection.id,
      items: [{ priceId: price.id, quantity: 1 }],
      successUrl: "https://x.test/success",
      cancelUrl: "https://x.test/cancel",
    },
    db,
  );
  return { app, customer, connection, checkout, slug };
}

async function send(
  app: { id: string },
  connection: { id: string },
  slug: string,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify(payload);
  await processProviderWebhook(app.id, connection.id, {
    rawBody: body,
    headers: {
      "x-monetplane-mock-signature": signMockWebhookPayload(
        body,
        `${slug}-secret`,
      ),
    },
  });
}

async function accountOf(appId: string) {
  const [account] = await db
    .select()
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.applicationId, appId),
        eq(creditAccounts.creditType, "tokens"),
      ),
    )
    .limit(1);
  return account;
}

describe("subscription credit clawback (PR-C)", () => {
  it("cancellation webhook revokes unused cycle credits as grant.revoked", async () => {
    const { app, customer, connection, checkout, slug } =
      await seed("revoke-cancel");

    await send(app, connection, slug, {
      id: "evt-rc-1",
      type: "subscription.activated",
      occurred_at: "2026-01-01T00:00:00.000Z",
      data: {
        provider_subscription_id: "sub_rc",
        monetplane_order_id: checkout.orderId,
        monetplane_customer_id: customer.customerId,
        subscription_status: "active",
        subscription_period_start: "2026-01-01T00:00:00.000Z",
        subscription_period_end: "2026-02-01T00:00:00.000Z",
      },
    });
    let account = await accountOf(app.id);
    expect(account?.availableBalance).toBe(100);

    // Consume 30 through the real ledger path (keeps the invariant).
    const { debitCredits } = await import("../../src/modules/credits/service");
    await debitCredits(
      {
        applicationId: app.id,
        externalCustomerId: "u1",
        creditType: "tokens",
        amount: 30,
        sourceType: "test",
        sourceId: "consume-30",
        idempotencyKey: "d-rc-1",
      },
      db,
    );

    // Cancel the subscription (immediate).
    await send(app, connection, slug, {
      id: "evt-rc-2",
      type: "subscription.cancelled",
      occurred_at: "2026-01-15T00:00:00.000Z",
      data: {
        provider_subscription_id: "sub_rc",
        monetplane_order_id: checkout.orderId,
        monetplane_customer_id: customer.customerId,
        cancel_at_period_end: false,
      },
    });

    account = await accountOf(app.id);
    expect(account?.availableBalance).toBe(0);

    const revoked = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.applicationId, app.id),
          eq(creditTransactions.type, "grant.revoked"),
        ),
      );
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.amount).toBe(-70);
    expect(revoked[0]?.metadata).toMatchObject({
      reason: "subscription_cancelled",
    });
  });

  it("clawback is bounded by available when a reservation is open (invariant preserved)", async () => {
    const { app, customer } = await seed("revoke-reserve");

    // Grant directly from a synthetic subscription source.
    const { grantCredits } = await import("../../src/modules/credits/service");
    await grantCredits(
      {
        applicationId: app.id,
        applicationCustomerId: customer.id,
        creditType: "tokens",
        amount: 100,
        transactionType: "grant.subscription",
        sourceType: "subscription",
        sourceId: "sub_rr",
        idempotencyKey: "g-rr",
        environment: "test",
      },
      db,
    );

    // Reserve 40: available=60, reserved=40.
    await reserveCredits(
      {
        applicationId: app.id,
        externalCustomerId: "u1",
        creditType: "tokens",
        amount: 40,
        referenceType: "job",
        referenceId: "j-rr",
        idempotencyKey: "r-rr",
      },
      db,
    );
    let account = await accountOf(app.id);
    expect(account?.availableBalance).toBe(60);
    expect(account?.reservedBalance).toBe(40);

    // Clawback can only take up to available (60), not the full bucket.
    const result = await revokeSubscriptionCredits(
      { applicationId: app.id, subscriptionId: "sub_rr" },
      db,
    );
    expect(result).toEqual([{ creditType: "tokens", revokedAmount: 60 }]);

    account = await accountOf(app.id);
    expect(account?.availableBalance).toBe(0);
    expect(account?.reservedBalance).toBe(40); // untouched

    // Invariant: sum(active bucket remaining) == available + reserved.
    const { creditBuckets } = await import("../../src/modules/credits/schema");
    const buckets = await db
      .select({
        remaining: creditBuckets.remainingAmount,
        status: creditBuckets.status,
      })
      .from(creditBuckets)
      .where(eq(creditBuckets.creditAccountId, account?.id ?? ""));
    const activeSum = buckets
      .filter((b) => b.status === "active")
      .reduce((s, b) => s + b.remaining, 0);
    expect(activeSum).toBe(40); // == available(0) + reserved(40)
  });

  it("is a no-op for subscriptions without credit grants", async () => {
    const { app } = await seed("revoke-none");
    const result = await revokeSubscriptionCredits(
      { applicationId: app.id, subscriptionId: "sub_none" },
      db,
    );
    expect(result).toEqual([]);
  });
});
