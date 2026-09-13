import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import type { PaymentProviderAdapter } from "../../src/modules/providers/contract";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import {
  createProviderConnection,
  revokeProviderConnection,
} from "../../src/modules/providers/service";
import {
  ConsoleProviderDiagnosticError,
  runConsoleProviderDiagnostic,
} from "../../src/server/control-plane/providers";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

let paymentLookups = 0;
let subscriptionLookups = 0;
let mutationCalls = 0;

const diagnosticAdapter: PaymentProviderAdapter = {
  ...mockProviderAdapter,
  provider: "diagnostic-test",
  async getPayment(connection, input) {
    paymentLookups += 1;
    const result = await mockProviderAdapter.getPayment(connection, input);
    return { ...result, amountMinor: 4200, currency: "USD" };
  },
  async getSubscription(connection, input) {
    subscriptionLookups += 1;
    return mockProviderAdapter.getSubscription(connection, input);
  },
  async refundPayment(connection, input) {
    mutationCalls += 1;
    return mockProviderAdapter.refundPayment(connection, input);
  },
  async cancelSubscription(connection, input) {
    mutationCalls += 1;
    return mockProviderAdapter.cancelSubscription(connection, input);
  },
  async updateSubscription(connection, input) {
    mutationCalls += 1;
    return mockProviderAdapter.updateSubscription(connection, input);
  },
};

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  paymentLookups = 0;
  subscriptionLookups = 0;
  mutationCalls = 0;
  clearProviderAdaptersForTests();
  registerProviderAdapter(diagnosticAdapter);
  await db.delete(applications);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

async function seedConnection() {
  const app = await createApplication(
    { slug: "provider-diagnostics", name: "Provider Diagnostics" },
    db,
  );
  const connection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "diagnostic-test",
      name: "sandbox diagnostics",
      mode: "test",
      credentials: {
        apiKey: "diagnostic-api-key",
        webhookSecret: "diagnostic-webhook-secret",
      },
    },
    db,
  );
  return { app, connection };
}

describe("provider diagnostics", () => {
  it("resolves runtime configuration without invoking a provider mutation", async () => {
    const { app, connection } = await seedConnection();

    const result = await runConsoleProviderDiagnostic(
      app.id,
      connection.id,
      "test",
      { kind: "configuration" },
    );

    expect(result.status).toBe("passed");
    expect(result.provider).toBe("diagnostic-test");
    expect(result.environment).toBe("test");
    expect(result.capabilities?.some((item) => item.supported)).toBe(true);
    expect(paymentLookups).toBe(0);
    expect(subscriptionLookups).toBe(0);
    expect(mutationCalls).toBe(0);
  });

  it("performs normalized read-only payment and subscription lookups", async () => {
    const { app, connection } = await seedConnection();

    const payment = await runConsoleProviderDiagnostic(
      app.id,
      connection.id,
      "test",
      { kind: "payment", providerResourceId: "provider_payment_123" },
    );
    expect(payment.payment).toMatchObject({
      providerPaymentId: "provider_payment_123",
      status: "succeeded",
      amountMinor: 4200,
      currency: "USD",
    });

    const subscription = await runConsoleProviderDiagnostic(
      app.id,
      connection.id,
      "test",
      {
        kind: "subscription",
        providerResourceId: "provider_subscription_123",
      },
    );
    expect(subscription.subscription).toMatchObject({
      providerSubscriptionId: "provider_subscription_123",
      status: "active",
      cancelAtPeriodEnd: false,
    });

    expect(paymentLookups).toBe(1);
    expect(subscriptionLookups).toBe(1);
    expect(mutationCalls).toBe(0);
  });

  it("enforces environment and revoked-connection boundaries", async () => {
    const { app, connection } = await seedConnection();

    await expect(
      runConsoleProviderDiagnostic(app.id, connection.id, "live", {
        kind: "configuration",
      }),
    ).rejects.toMatchObject<Partial<ConsoleProviderDiagnosticError>>({
      code: "not_found",
    });

    await revokeProviderConnection(app.id, connection.id, db);

    await expect(
      runConsoleProviderDiagnostic(app.id, connection.id, "test", {
        kind: "configuration",
      }),
    ).rejects.toMatchObject<Partial<ConsoleProviderDiagnosticError>>({
      code: "revoked",
    });
    expect(mutationCalls).toBe(0);
  });
});
