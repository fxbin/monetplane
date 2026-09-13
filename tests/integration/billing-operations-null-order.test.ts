import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { payments, refunds } from "../../src/modules/commerce/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { billingOperations } from "../../src/modules/operations/schema";
import { createProviderConnection } from "../../src/modules/providers/service";
import { reconcileBillingOperation } from "../../src/server/control-plane/billing-operation-actions";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
});

afterAll(() => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
});

it("reconciles a refunded payment without an order by syncing payment and refund only", async () => {
  const app = await createApplication(
    { slug: "operations-null-order", name: "Operations Null Order" },
    db,
  );
  const customer = await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "null-order-user",
    },
    db,
  );
  const connection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "operations-null-order-test",
      mode: "test",
      credentials: {
        apiKey: "test-key",
        webhookSecret: "test-webhook-secret",
      },
    },
    db,
  );

  const paymentId = "pay_operations_null_order";
  await db.insert(payments).values({
    id: paymentId,
    applicationId: app.id,
    customerId: customer.customerId,
    providerConnectionId: connection.id,
    providerPaymentId: "provider_payment_null_order",
    status: "succeeded",
    amountMinor: 1200,
    currency: "USD",
  });

  const operationId = "bop_operations_null_order";
  await db.insert(billingOperations).values({
    id: operationId,
    applicationId: app.id,
    type: "refund",
    resourceType: "payment",
    resourceId: paymentId,
    providerConnectionId: connection.id,
    providerResourceId: "provider_payment_null_order",
    idempotencyKey: `refund:${paymentId}:full`,
    status: "needs_reconciliation",
    normalizedResult: {
      providerRefundId: "provider_refund_null_order",
      providerPaymentId: "provider_payment_null_order",
      status: "succeeded",
      amountMinor: 1200,
    },
    errorMessage: "simulated local persistence interruption",
  });

  const operation = await reconcileBillingOperation(app.id, operationId, "test");
  expect(operation.status).toBe("completed");

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId));
  const [refund] = await db
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, paymentId));

  expect(payment?.status).toBe("refunded");
  expect(refund?.status).toBe("succeeded");
  expect(refund?.orderId).toBeNull();
  expect(refund?.providerRefundId).toBe("provider_refund_null_order");
});
