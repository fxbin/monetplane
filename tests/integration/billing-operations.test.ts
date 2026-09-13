import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import {
  addProductGrantConfig,
  createPrice,
  createProduct,
} from "../../src/modules/catalog/service";
import {
  orderItems,
  orders,
  payments,
  refunds,
  subscriptionItems,
  subscriptions,
} from "../../src/modules/commerce/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { entitlementGrants } from "../../src/modules/entitlements/schema";
import { grantEntitlement } from "../../src/modules/entitlements/service";
import { billingOperations } from "../../src/modules/operations/schema";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import type { PaymentProviderAdapter, ProviderMode } from "../../src/modules/providers/contract";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import {
  cancelSubscriptionWithJournal,
  reconcileBillingOperation,
  refundPaymentWithJournal,
} from "../../src/server/control-plane/billing-operation-actions";
import {
  getPaymentDetail,
  getPaymentsList,
} from "../../src/server/control-plane/billing-operations";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
let refundCalls = 0;
let cancelCalls = 0;

const countingAdapter: PaymentProviderAdapter = {
  ...mockProviderAdapter,
  async refundPayment(connection, input) {
    refundCalls += 1;
    return mockProviderAdapter.refundPayment(connection, input);
  },
  async cancelSubscription(connection, input) {
    cancelCalls += 1;
    return mockProviderAdapter.cancelSubscription(connection, input);
  },
};

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  refundCalls = 0;
  cancelCalls = 0;
  clearProviderAdaptersForTests();
  registerProviderAdapter(countingAdapter);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

async function createConnection(applicationId: string, mode: ProviderMode) {
  return createProviderConnection(
    {
      applicationId,
      provider: "mock",
      name: `operations-${mode}`,
      mode,
      credentials: {
        apiKey: `${mode}-key`,
        webhookSecret: `${mode}-webhook-secret`,
      },
    },
    db,
  );
}

async function seedOneTimePayment(options?: {
  mode?: ProviderMode;
  creditGrant?: boolean;
  suffix?: string;
}) {
  const mode = options?.mode ?? "test";
  const suffix = options?.suffix ?? mode;
  const app = await createApplication(
    { slug: `operations-${suffix}`, name: `Operations ${suffix}` },
    db,
  );
  const customer = await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: `user-${suffix}`,
      email: `${suffix}@example.com`,
    },
    db,
  );
  const connection = await createConnection(app.id, mode);
  const product = await createProduct(
    {
      applicationId: app.id,
      key: `product-${suffix}`,
      name: `Product ${suffix}`,
    },
    db,
  );
  if (options?.creditGrant) {
    await addProductGrantConfig(
      {
        applicationId: app.id,
        productId: product.id,
        grantType: "credit",
        referenceKey: "generation",
        quantity: 100,
      },
      db,
    );
  }
  const price = await createPrice(
    {
      applicationId: app.id,
      productId: product.id,
      key: "default",
      currency: "USD",
      amountMinor: 4900,
      billingType: "one_time",
    },
    db,
  );
  const orderId = `ord_${suffix}`;
  const paymentId = `pay_${suffix}`;
  await db.insert(orders).values({
    id: orderId,
    applicationId: app.id,
    applicationCustomerId: customer.id,
    billingMode: "one_time",
    status: "paid",
    currency: "USD",
    totalAmountMinor: 4900,
  });
  await db.insert(orderItems).values({
    id: `item_${suffix}`,
    orderId,
    productId: product.id,
    priceId: price.id,
    quantity: 1,
    unitAmountMinor: 4900,
  });
  await db.insert(payments).values({
    id: paymentId,
    applicationId: app.id,
    orderId,
    customerId: customer.customerId,
    providerConnectionId: connection.id,
    providerPaymentId: `provider_payment_${suffix}`,
    status: "succeeded",
    amountMinor: 4900,
    currency: "USD",
  });
  return { app, customer, connection, product, price, orderId, paymentId };
}

describe("billing operations console", () => {
  it("journals a safe refund and makes request retries provider-idempotent", async () => {
    const seed = await seedOneTimePayment({ suffix: "refund" });
    await grantEntitlement(
      {
        applicationId: seed.app.id,
        applicationCustomerId: seed.customer.id,
        featureKey: "lifetime.access",
        sourceType: "order",
        sourceId: seed.orderId,
        idempotencyKey: "operations-refund-entitlement",
        validFrom: new Date("2026-09-01T00:00:00Z"),
      },
      db,
    );

    const before = await getPaymentDetail(seed.app.id, seed.paymentId, "test");
    expect(before.refundEligibility).toEqual({ eligible: true, reason: null });

    const first = await refundPaymentWithJournal(
      seed.app.id,
      seed.paymentId,
      "test",
    );
    expect(first.status).toBe("completed");
    expect(refundCalls).toBe(1);

    const retried = await refundPaymentWithJournal(
      seed.app.id,
      seed.paymentId,
      "test",
    );
    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("completed");
    expect(refundCalls).toBe(1);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, seed.paymentId));
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, seed.orderId));
    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, seed.paymentId));
    const [entitlement] = await db
      .select()
      .from(entitlementGrants)
      .where(eq(entitlementGrants.sourceId, seed.orderId));
    const operationRows = await db
      .select()
      .from(billingOperations)
      .where(eq(billingOperations.resourceId, seed.paymentId));

    expect(payment?.status).toBe("refunded");
    expect(order?.status).toBe("refunded");
    expect(refundRows).toHaveLength(1);
    expect(entitlement?.status).toBe("revoked");
    expect(operationRows).toHaveLength(1);
    expect(operationRows[0]?.status).toBe("completed");
  });

  it("blocks credit-grant refunds before creating a journal or calling the provider", async () => {
    const seed = await seedOneTimePayment({
      suffix: "credit-pack",
      creditGrant: true,
    });

    const detail = await getPaymentDetail(seed.app.id, seed.paymentId, "test");
    expect(detail.refundEligibility.eligible).toBe(false);
    expect(detail.refundEligibility.reason).toContain("granted credits");

    await expect(
      refundPaymentWithJournal(seed.app.id, seed.paymentId, "test"),
    ).rejects.toThrow("granted credits");
    expect(refundCalls).toBe(0);

    const operations = await db
      .select()
      .from(billingOperations)
      .where(eq(billingOperations.resourceId, seed.paymentId));
    expect(operations).toHaveLength(0);
  });

  it("journals subscription cancellation and avoids a second provider call on retry", async () => {
    const app = await createApplication(
      { slug: "operations-cancel", name: "Operations Cancel" },
      db,
    );
    const customer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "cancel-user" },
      db,
    );
    const connection = await createConnection(app.id, "test");
    const product = await createProduct(
      { applicationId: app.id, key: "pro", name: "Pro" },
      db,
    );
    const price = await createPrice(
      {
        applicationId: app.id,
        productId: product.id,
        key: "monthly",
        currency: "USD",
        amountMinor: 999,
        billingType: "recurring",
        recurringInterval: "month",
        intervalCount: 1,
      },
      db,
    );
    const subscriptionId = "sub_operations_cancel";
    await db.insert(subscriptions).values({
      id: subscriptionId,
      applicationId: app.id,
      applicationCustomerId: customer.id,
      providerConnectionId: connection.id,
      providerSubscriptionId: "provider_sub_cancel",
      status: "active",
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    await db.insert(subscriptionItems).values({
      id: "subitem_operations_cancel",
      subscriptionId,
      productId: product.id,
      priceId: price.id,
      quantity: 1,
    });
    await grantEntitlement(
      {
        applicationId: app.id,
        applicationCustomerId: customer.id,
        featureKey: "pro.analytics",
        sourceType: "subscription",
        sourceId: subscriptionId,
        idempotencyKey: "operations-cancel-entitlement",
        validFrom: new Date("2026-09-01T00:00:00Z"),
        validUntil: new Date("2026-10-01T00:00:00Z"),
      },
      db,
    );

    const first = await cancelSubscriptionWithJournal(
      app.id,
      subscriptionId,
      "test",
    );
    expect(first.status).toBe("completed");
    expect(cancelCalls).toBe(1);

    const retried = await cancelSubscriptionWithJournal(
      app.id,
      subscriptionId,
      "test",
    );
    expect(retried.id).toBe(first.id);
    expect(cancelCalls).toBe(1);

    const [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));
    const [entitlement] = await db
      .select()
      .from(entitlementGrants)
      .where(eq(entitlementGrants.sourceId, subscriptionId));
    expect(subscription?.status).toBe("cancelled");
    expect(entitlement?.status).toBe("revoked");
  });

  it("reconciles an already-provider-succeeded refund without calling the provider", async () => {
    const seed = await seedOneTimePayment({ suffix: "reconcile" });
    const operationId = "bop_reconcile_refund";
    await db.insert(billingOperations).values({
      id: operationId,
      applicationId: seed.app.id,
      type: "refund",
      resourceType: "payment",
      resourceId: seed.paymentId,
      providerConnectionId: seed.connection.id,
      providerResourceId: `provider_payment_reconcile`,
      idempotencyKey: `refund:${seed.paymentId}:full`,
      status: "needs_reconciliation",
      normalizedResult: {
        providerRefundId: "provider_refund_reconcile",
        providerPaymentId: "provider_payment_reconcile",
        status: "succeeded",
        amountMinor: 4900,
      },
      errorMessage: "simulated local persistence interruption",
    });

    await expect(
      reconcileBillingOperation(seed.app.id, operationId, "live"),
    ).rejects.toThrow("selected environment");
    expect(refundCalls).toBe(0);

    const reconciled = await reconcileBillingOperation(
      seed.app.id,
      operationId,
      "test",
    );
    expect(reconciled.status).toBe("completed");
    expect(refundCalls).toBe(0);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, seed.paymentId));
    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, seed.paymentId));
    expect(payment?.status).toBe("refunded");
    expect(refundRows).toHaveLength(1);
  });

  it("keeps Sandbox and Production payment reads isolated by provider mode", async () => {
    const app = await createApplication(
      { slug: "operations-env", name: "Operations Env" },
      db,
    );
    const customer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "env-user" },
      db,
    );
    const testConnection = await createConnection(app.id, "test");
    const liveConnection = await createConnection(app.id, "live");

    for (const [mode, connection] of [
      ["test", testConnection],
      ["live", liveConnection],
    ] as const) {
      await db.insert(payments).values({
        id: `pay_env_${mode}`,
        applicationId: app.id,
        customerId: customer.customerId,
        providerConnectionId: connection.id,
        providerPaymentId: `provider_pay_env_${mode}`,
        status: "succeeded",
        amountMinor: 1000,
        currency: "USD",
      });
    }

    const sandbox = await getPaymentsList(app.id, { providerMode: "test" });
    const production = await getPaymentsList(app.id, { providerMode: "live" });
    expect(sandbox.map((row) => row.id)).toEqual(["pay_env_test"]);
    expect(production.map((row) => row.id)).toEqual(["pay_env_live"]);

    await expect(
      getPaymentDetail(app.id, "pay_env_live", "test"),
    ).rejects.toThrow("selected project/environment");
  });
});
