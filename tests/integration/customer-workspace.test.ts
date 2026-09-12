import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
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
  subscriptions,
} from "../../src/modules/commerce/schema";
import { creditTransactions } from "../../src/modules/credits/schema";
import { applicationCustomers, customers } from "../../src/modules/customers/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { entitlementGrants } from "../../src/modules/entitlements/schema";
import { grantEntitlement } from "../../src/modules/entitlements/service";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import {
  cancelCustomerSubscription,
  getCustomerWorkspace,
  getCustomerWorkspaceList,
  grantCustomerCredits,
  refundCustomerPayment,
} from "../../src/server/control-plane/customer-workspace";

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
  await db.delete(customers);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

async function createMockConnection(applicationId: string) {
  return createProviderConnection(
    {
      applicationId,
      provider: "mock",
      name: "workspace-mock",
      mode: "test",
      credentials: {
        apiKey: "mock-key",
        webhookSecret: "mock-webhook-secret",
      },
    },
    db,
  );
}

describe("customer billing workspace", () => {
  it("keeps list/detail and manual credit grants application-isolated", async () => {
    const firstApp = await createApplication(
      { slug: "workspace-a", name: "Workspace A" },
      db,
    );
    const secondApp = await createApplication(
      { slug: "workspace-b", name: "Workspace B" },
      db,
    );
    const firstCustomer = await createApplicationCustomer(
      {
        applicationId: firstApp.id,
        externalCustomerId: "same-external-id",
        email: "first@example.com",
      },
      db,
    );
    const secondCustomer = await createApplicationCustomer(
      {
        applicationId: secondApp.id,
        externalCustomerId: "same-external-id",
        email: "second@example.com",
      },
      db,
    );

    await grantCustomerCredits(firstApp.id, firstCustomer.id, {
      creditType: "generation",
      amount: 250,
      note: "support adjustment",
    });

    const firstList = await getCustomerWorkspaceList(firstApp.id);
    const secondList = await getCustomerWorkspaceList(secondApp.id);
    expect(firstList).toHaveLength(1);
    expect(firstList[0]).toMatchObject({
      id: firstCustomer.id,
      credits: { available: 250, reserved: 0 },
    });
    expect(secondList).toHaveLength(1);
    expect(secondList[0]).toMatchObject({
      id: secondCustomer.id,
      credits: { available: 0, reserved: 0 },
    });

    const workspace = await getCustomerWorkspace(firstApp.id, firstCustomer.id);
    expect(workspace.creditLedger[0]).toMatchObject({
      type: "adjustment.admin",
      amount: 250,
      sourceType: "admin",
    });
    await expect(
      getCustomerWorkspace(firstApp.id, secondCustomer.id),
    ).rejects.toThrow("Customer not found");
  });

  it("cancels a provider subscription and revokes its active entitlement", async () => {
    const app = await createApplication(
      { slug: "workspace-cancel", name: "Workspace Cancel" },
      db,
    );
    const customer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "cancel-user" },
      db,
    );
    const connection = await createMockConnection(app.id);
    const subscriptionId = "sub_workspace_cancel";
    await db.insert(subscriptions).values({
      id: subscriptionId,
      applicationId: app.id,
      applicationCustomerId: customer.id,
      providerConnectionId: connection.id,
      providerSubscriptionId: "provider-sub-cancel",
      status: "active",
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    await grantEntitlement(
      {
        applicationId: app.id,
        applicationCustomerId: customer.id,
        featureKey: "pro.analytics",
        sourceType: "subscription",
        sourceId: subscriptionId,
        idempotencyKey: "workspace-cancel-entitlement",
        validFrom: new Date("2026-09-01T00:00:00Z"),
        validUntil: new Date("2026-10-01T00:00:00Z"),
      },
      db,
    );

    const result = await cancelCustomerSubscription(
      app.id,
      customer.id,
      subscriptionId,
    );
    expect(result.status).toBe("cancelled");

    const [storedSubscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));
    const [storedEntitlement] = await db
      .select()
      .from(entitlementGrants)
      .where(eq(entitlementGrants.sourceId, subscriptionId));
    expect(storedSubscription?.status).toBe("cancelled");
    expect(storedEntitlement?.status).toBe("revoked");
  });

  it("refunds a safe one-time payment and synchronizes local billing state", async () => {
    const app = await createApplication(
      { slug: "workspace-refund", name: "Workspace Refund" },
      db,
    );
    const customer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "refund-user" },
      db,
    );
    const connection = await createMockConnection(app.id);
    const product = await createProduct(
      { applicationId: app.id, key: "lifetime", name: "Lifetime" },
      db,
    );
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
    const orderId = "ord_workspace_refund";
    const paymentId = "pay_workspace_refund";
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
      id: "item_workspace_refund",
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
      providerPaymentId: "provider-payment-refund",
      status: "succeeded",
      amountMinor: 4900,
      currency: "USD",
    });
    await grantEntitlement(
      {
        applicationId: app.id,
        applicationCustomerId: customer.id,
        featureKey: "lifetime.access",
        sourceType: "order",
        sourceId: orderId,
        idempotencyKey: "workspace-refund-entitlement",
        validFrom: new Date("2026-09-01T00:00:00Z"),
      },
      db,
    );

    const result = await refundCustomerPayment(app.id, customer.id, paymentId);
    expect(result.status).toBe("succeeded");

    const [storedPayment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    const [storedOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));
    const storedRefunds = await db
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, paymentId));
    const [storedEntitlement] = await db
      .select()
      .from(entitlementGrants)
      .where(eq(entitlementGrants.sourceId, orderId));
    expect(storedPayment?.status).toBe("refunded");
    expect(storedOrder?.status).toBe("refunded");
    expect(storedRefunds).toHaveLength(1);
    expect(storedEntitlement?.status).toBe("revoked");
  });

  it("blocks refunds when the purchase granted credits", async () => {
    const app = await createApplication(
      { slug: "workspace-credit-refund", name: "Workspace Credit Refund" },
      db,
    );
    const customer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "credit-refund-user" },
      db,
    );
    const connection = await createMockConnection(app.id);
    const product = await createProduct(
      { applicationId: app.id, key: "credits-pack", name: "Credits Pack" },
      db,
    );
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
    const price = await createPrice(
      {
        applicationId: app.id,
        productId: product.id,
        key: "default",
        currency: "USD",
        amountMinor: 1000,
        billingType: "one_time",
      },
      db,
    );
    const orderId = "ord_workspace_credit_refund";
    const paymentId = "pay_workspace_credit_refund";
    await db.insert(orders).values({
      id: orderId,
      applicationId: app.id,
      applicationCustomerId: customer.id,
      billingMode: "one_time",
      status: "paid",
      currency: "USD",
      totalAmountMinor: 1000,
    });
    await db.insert(orderItems).values({
      id: "item_workspace_credit_refund",
      orderId,
      productId: product.id,
      priceId: price.id,
      quantity: 1,
      unitAmountMinor: 1000,
    });
    await db.insert(payments).values({
      id: paymentId,
      applicationId: app.id,
      orderId,
      customerId: customer.customerId,
      providerConnectionId: connection.id,
      providerPaymentId: "provider-payment-credit-refund",
      status: "succeeded",
      amountMinor: 1000,
      currency: "USD",
    });

    await expect(
      refundCustomerPayment(app.id, customer.id, paymentId),
    ).rejects.toThrow("granted credits");
    const [storedPayment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(storedPayment?.status).toBe("succeeded");
  });

  it("records manual grants in the shared ledger table", async () => {
    const app = await createApplication(
      { slug: "workspace-ledger", name: "Workspace Ledger" },
      db,
    );
    const customer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "ledger-user" },
      db,
    );
    await grantCustomerCredits(app.id, customer.id, {
      creditType: "generation",
      amount: 50,
    });
    const rows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationCustomerId, customer.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "adjustment.admin",
      amount: 50,
    });
  });
});
