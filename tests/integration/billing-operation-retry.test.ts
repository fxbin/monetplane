import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import {
  orderItems,
  orders,
  payments,
} from "../../src/modules/commerce/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { billingOperations } from "../../src/modules/operations/schema";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import {
  type PaymentProviderAdapter,
  ProviderOperationError,
} from "../../src/modules/providers/contract";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import {
  refundPaymentWithJournal,
  retryBillingOperation,
} from "../../src/server/control-plane/billing-operation-actions";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
let behavior: "reject" | "uncertain" | "success" = "reject";
let refundCalls = 0;

const retryAdapter: PaymentProviderAdapter = {
  ...mockProviderAdapter,
  provider: "retry-test",
  async refundPayment(connection, input) {
    refundCalls += 1;
    if (behavior === "reject") {
      throw new ProviderOperationError("provider rejected request", "rejected");
    }
    if (behavior === "uncertain") {
      throw new Error("socket closed before response");
    }
    return mockProviderAdapter.refundPayment(connection, input);
  },
};

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  behavior = "reject";
  refundCalls = 0;
  clearProviderAdaptersForTests();
  registerProviderAdapter(retryAdapter);
  await db.delete(applications);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

async function seedPayment(suffix: string) {
  const app = await createApplication(
    { slug: `retry-${suffix}`, name: `Retry ${suffix}` },
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
  const connection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "retry-test",
      name: "retry provider",
      mode: "test",
      credentials: { apiKey: "test-key", webhookSecret: "test-secret" },
    },
    db,
  );
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
      amountMinor: 2500,
      billingType: "one_time",
    },
    db,
  );
  const orderId = `ord_retry_${suffix}`;
  const paymentId = `pay_retry_${suffix}`;
  await db.insert(orders).values({
    id: orderId,
    applicationId: app.id,
    applicationCustomerId: customer.id,
    billingMode: "one_time",
    status: "paid",
    currency: "USD",
    totalAmountMinor: 2500,
  });
  await db.insert(orderItems).values({
    id: `item_retry_${suffix}`,
    orderId,
    productId: product.id,
    priceId: price.id,
    quantity: 1,
    unitAmountMinor: 2500,
  });
  await db.insert(payments).values({
    id: paymentId,
    applicationId: app.id,
    orderId,
    customerId: customer.customerId,
    providerConnectionId: connection.id,
    providerPaymentId: `provider_payment_retry_${suffix}`,
    status: "succeeded",
    amountMinor: 2500,
    currency: "USD",
  });
  return { app, paymentId };
}

describe("classified billing operation retries", () => {
  it("creates a new retry attempt only after a deterministic rejection", async () => {
    const seed = await seedPayment("rejected");

    await expect(
      refundPaymentWithJournal(seed.app.id, seed.paymentId, "test"),
    ).rejects.toThrow("provider rejected request");

    const [first] = await db
      .select()
      .from(billingOperations)
      .where(eq(billingOperations.resourceId, seed.paymentId));
    expect(first?.status).toBe("failed");
    expect(first?.failureKind).toBe("rejected");
    expect(first?.attemptNumber).toBe(1);
    expect(first?.retryOfOperationId).toBeNull();
    if (!first) throw new Error("Expected first billing operation");

    behavior = "success";
    const retried = await retryBillingOperation(seed.app.id, first.id, "test");
    expect(retried.status).toBe("completed");
    expect(refundCalls).toBe(2);

    const attempts = await db
      .select()
      .from(billingOperations)
      .where(eq(billingOperations.resourceId, seed.paymentId));
    expect(attempts).toHaveLength(2);
    const second = attempts.find((operation) => operation.id !== first.id);
    expect(second?.retryOfOperationId).toBe(first.id);
    expect(second?.attemptNumber).toBe(2);
    expect(second?.failureKind).toBeNull();
    expect(second?.status).toBe("completed");
  });

  it("blocks retry when the provider outcome is uncertain", async () => {
    const seed = await seedPayment("uncertain");
    behavior = "uncertain";

    await expect(
      refundPaymentWithJournal(seed.app.id, seed.paymentId, "test"),
    ).rejects.toThrow("socket closed before response");

    const [operation] = await db
      .select()
      .from(billingOperations)
      .where(eq(billingOperations.resourceId, seed.paymentId));
    expect(operation?.status).toBe("failed");
    expect(operation?.failureKind).toBe("outcome_uncertain");
    if (!operation) throw new Error("Expected failed billing operation");

    await expect(
      retryBillingOperation(seed.app.id, operation.id, "test"),
    ).rejects.toThrow("outcome is uncertain");
    expect(refundCalls).toBe(1);
  });
});
