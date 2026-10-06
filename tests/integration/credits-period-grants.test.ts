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
import { expireDueCreditBuckets } from "../../src/modules/credits/buckets";
import {
  creditAccounts,
  creditBuckets,
} from "../../src/modules/credits/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
import { registerProviderAdapter } from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import { setupIntegrationFile } from "./test-setup";

/**
 * Period-reset quota semantics (roundtable 2026-10-06, PR-B): a
 * subscription cycle's credit grant lands in a bucket that expires with
 * the cycle's period end. The next cycle's grant lands in a fresh bucket.
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

function subscriptionRenewal(payload: {
  id: string;
  subscriptionId: string;
  orderId: string;
  customerId: string;
  periodStart: string;
  periodEnd: string;
}) {
  return {
    id: payload.id,
    type: "subscription.renewed",
    occurred_at: payload.periodStart,
    data: {
      provider_subscription_id: payload.subscriptionId,
      monetplane_order_id: payload.orderId,
      monetplane_customer_id: payload.customerId,
      subscription_status: "active",
      subscription_period_start: payload.periodStart,
      subscription_period_end: payload.periodEnd,
    },
  };
}

describe("period-reset quota semantics (PR-B)", () => {
  it("grants each cycle in a bucket expiring with the cycle; old cycle expires before the next", async () => {
    const slug = `period-${Math.random().toString(36).slice(2, 8)}`;
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

    // Send renewals directly through the webhook inbox.
    const send = async (payload: ReturnType<typeof subscriptionRenewal>) => {
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
    };

    // Cycle 1: Jan 1 – Feb 1
    await send(
      subscriptionRenewal({
        id: "evt-p1",
        subscriptionId: "sub_p1",
        orderId: checkout.orderId,
        customerId: customer.customerId,
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2026-02-01T00:00:00.000Z",
      }),
    );
    // Cycle 2: Feb 1 – Mar 1
    await send(
      subscriptionRenewal({
        id: "evt-p2",
        subscriptionId: "sub_p1",
        orderId: checkout.orderId,
        customerId: customer.customerId,
        periodStart: "2026-02-01T00:00:00.000Z",
        periodEnd: "2026-03-01T00:00:00.000Z",
      }),
    );

    const [account] = await db
      .select()
      .from(creditAccounts)
      .where(
        and(
          eq(creditAccounts.applicationId, app.id),
          eq(creditAccounts.creditType, "tokens"),
        ),
      )
      .limit(1);
    expect(account?.availableBalance).toBe(200);

    const buckets = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.creditAccountId, account?.id ?? ""))
      .orderBy(creditBuckets.createdAt);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.expiresAt?.toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
    expect(buckets[1]?.expiresAt?.toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );

    // The expiry sweep (run "now", past both periods) clears both cycles.
    const expired = await expireDueCreditBuckets(db, new Date());
    expect(expired.length).toBeGreaterThanOrEqual(2);
    const [after] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, account?.id ?? ""))
      .limit(1);
    expect(after?.availableBalance).toBe(0);
  });
});
