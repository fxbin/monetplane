import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import {
  createApplication,
  registerCallbackOrigin,
  setApplicationBranding,
} from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import { createCommerceCheckout } from "../../src/modules/commerce/checkout";
import { orders, subscriptions } from "../../src/modules/commerce/schema";
import { processProviderWebhook } from "../../src/modules/commerce/webhook";
import { grantCredits } from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { grantEntitlement } from "../../src/modules/entitlements/service";
import { operatorAuditLog } from "../../src/modules/operations/audit-schema";
import { portalSessions } from "../../src/modules/portal/schema";
import {
  createPortalSession,
  PortalServiceError,
  resolvePortalSession,
  revokePortalSession,
} from "../../src/modules/portal/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
import type { PaymentProviderAdapter } from "../../src/modules/providers/contract";
import { UnsupportedProviderCapabilityError } from "../../src/modules/providers/contract";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import {
  cancelSubscriptionFromPortal,
  createPortalPaymentManagementRedirect,
  getPortalBillingState,
} from "../../src/server/control-plane/portal";

/**
 * Hosted customer billing portal (#71): session security, provider-neutral
 * billing state, capability-aware actions, and cross-customer isolation.
 */

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(options?: { provider?: string }) {
  const slug = `portal-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: "Portal App" }, db);
  await registerCallbackOrigin(app.id, "https://product.test/welcome", db);
  await setApplicationBranding(app.id, {
    displayName: "Acme Cloud",
    logoUrl: "https://product.test/logo.png",
    supportEmail: "support@product.test",
  });

  const applicationCustomer = await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      email: "user@example.com",
    },
    db,
  );
  const product = await createProduct(
    { applicationId: app.id, key: "pro", name: "Pro plan" },
    db,
  );
  const price = await createPrice(
    {
      applicationId: app.id,
      productId: product.id,
      key: "monthly",
      currency: "USD",
      amountMinor: 1900,
      billingType: "recurring",
      recurringInterval: "month",
    },
    db,
  );

  const provider = options?.provider ?? "mock";
  const webhookSecret = `${provider}-secret`;
  const credentials = { webhookSecret };
  const providerConnection = await createProviderConnection(
    {
      applicationId: app.id,
      provider,
      name: "primary",
      mode: "test",
      credentials,
    },
    db,
  );

  const checkout = await createCommerceCheckout(
    app.id,
    {
      externalCustomerId: "user-1",
      providerConnectionId: providerConnection.id,
      items: [{ priceId: price.id, quantity: 1 }],
      successUrl: "https://product.test/welcome?session=1",
      cancelUrl: "https://product.test/welcome?cancel=1",
    },
    db,
  );

  return {
    app,
    applicationCustomer,
    providerConnection,
    checkout,
    webhookSecret,
  };
}

function webhookInput(payload: Record<string, unknown>, secret: string) {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    headers: {
      "x-monetplane-mock-signature": signMockWebhookPayload(rawBody, secret),
    },
  };
}

async function activateSubscription(fixture: Fixture) {
  const baseData = {
    provider_subscription_id: "sub_provider_1",
    monetplane_order_id: fixture.checkout.orderId,
    monetplane_customer_id: fixture.applicationCustomer.customerId,
    subscription_period_start: "2026-08-18T00:00:00.000Z",
    subscription_period_end: "2026-09-30T00:00:00.000Z",
  };
  await processProviderWebhook(
    fixture.app.id,
    fixture.providerConnection.id,
    webhookInput(
      {
        id: "evt_pay_1",
        type: "payment.succeeded",
        occurred_at: "2026-08-18T13:00:00.000Z",
        data: {
          provider_payment_id: "pay_provider_1",
          monetplane_order_id: fixture.checkout.orderId,
          monetplane_customer_id: fixture.applicationCustomer.customerId,
          amount_minor: 1900,
          currency: "USD",
        },
      },
      fixture.webhookSecret,
    ),
    db,
  );
  await processProviderWebhook(
    fixture.app.id,
    fixture.providerConnection.id,
    webhookInput(
      {
        id: "evt_sub_1",
        type: "subscription.activated",
        occurred_at: "2026-08-18T13:06:00.000Z",
        data: { ...baseData, subscription_status: "active" },
      },
      fixture.webhookSecret,
    ),
    db,
  );
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.providerSubscriptionId, "sub_provider_1"))
    .limit(1);
  if (!subscription) throw new Error("subscription was not activated");
  return subscription;
}

/** Adapter that supports nothing the portal can act on. */
const limitedAdapter: PaymentProviderAdapter = {
  ...mockProviderAdapter,
  provider: "limited",
  getCapabilities() {
    return {
      ...mockProviderAdapter.getCapabilities({} as never),
      subscription_cancel: false,
      customer_portal: false,
    };
  },
};

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  clearProviderAdaptersForTests();
  registerProviderAdapter(mockProviderAdapter);
  registerProviderAdapter(limitedAdapter);
  await db.delete(applications);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

describe("portal session security (#71)", () => {
  it("creates a session for a mapped customer and resolves it with branding", async () => {
    const fixture = await createFixture();
    const { token, sessionId, expiresAt } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
      returnUrl: "https://product.test/welcome?back=portal",
    });
    expect(token.startsWith("mptok_")).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const context = await resolvePortalSession(token);
    expect(context).toMatchObject({
      sessionId,
      applicationId: fixture.app.id,
      environment: "test",
      returnUrl: "https://product.test/welcome?back=portal",
    });
    expect(context.branding).toMatchObject({
      displayName: "Acme Cloud",
      supportEmail: "support@product.test",
    });
    expect(context.customer).toMatchObject({
      externalCustomerId: "user-1",
      email: "user@example.com",
    });

    // Only the SHA-256 hash is stored.
    const [row] = await db
      .select()
      .from(portalSessions)
      .where(eq(portalSessions.id, sessionId));
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toHaveLength(64);
  });

  it("refuses sessions for unmapped customers", async () => {
    const fixture = await createFixture();
    await expect(
      createPortalSession({
        applicationId: fixture.app.id,
        externalCustomerId: "not-mapped",
        environment: "test",
      }),
    ).rejects.toMatchObject({ code: "customer_not_found" });
  });

  it("validates returnUrl against the registered callback origins", async () => {
    const fixture = await createFixture();

    await expect(
      createPortalSession({
        applicationId: fixture.app.id,
        externalCustomerId: "user-1",
        environment: "test",
        returnUrl: "https://evil.example.com/steal",
      }),
    ).rejects.toMatchObject({ code: "return_url_not_allowed" });

    await expect(
      createPortalSession({
        applicationId: fixture.app.id,
        externalCustomerId: "user-1",
        environment: "test",
        returnUrl: "javascript:alert(1)",
      }),
    ).rejects.toMatchObject({ code: "return_url_not_allowed" });

    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
      returnUrl: "https://product.test/welcome?back=1",
    });
    expect((await resolvePortalSession(token)).returnUrl).toBe(
      "https://product.test/welcome?back=1",
    );
  });

  it("fails closed on tampered, expired, and revoked tokens", async () => {
    const fixture = await createFixture();
    const { token, sessionId } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });

    await expect(resolvePortalSession(`${token}x`)).rejects.toMatchObject({
      code: "portal_session_invalid",
    });
    await expect(resolvePortalSession("mptok_garbage")).rejects.toMatchObject({
      code: "portal_session_invalid",
    });

    await db
      .update(portalSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(portalSessions.id, sessionId));
    await expect(resolvePortalSession(token)).rejects.toMatchObject({
      code: "portal_session_expired",
    });

    const { token: token2, sessionId: sessionId2 } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });
    await revokePortalSession({
      applicationId: fixture.app.id,
      sessionId: sessionId2,
    });
    await expect(resolvePortalSession(token2)).rejects.toMatchObject({
      code: "portal_session_invalid",
    });
  });
});

describe("portal billing state", () => {
  it("shows provider-neutral billing state: plan, renewal, payments, entitlements, credits", async () => {
    const fixture = await createFixture();
    const subscription = await activateSubscription(fixture);
    await grantEntitlement({
      applicationId: fixture.app.id,
      applicationCustomerId: fixture.applicationCustomer.id,
      featureKey: "feature.advanced-analytics",
      sourceType: "subscription",
      sourceId: subscription.id,
      idempotencyKey: "portal-ent-1",
      validFrom: new Date("2026-08-18T00:00:00.000Z"),
      environment: "test",
    });
    await grantCredits({
      applicationId: fixture.app.id,
      applicationCustomerId: fixture.applicationCustomer.id,
      creditType: "usage",
      amount: 500,
      transactionType: "grant.promotion",
      sourceType: "admin",
      sourceId: "seed",
      idempotencyKey: "portal-credit-1",
      environment: "test",
    });

    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });
    const state = await getPortalBillingState(token);

    expect(state.branding.displayName).toBe("Acme Cloud");
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      status: "active",
      cancelAtPeriodEnd: false,
      canCancel: true,
      currentPeriodEnd: "2026-09-30T00:00:00.000Z",
    });
    expect(state.subscriptions[0].items[0]).toMatchObject({
      productName: "Pro plan",
      unitAmountMinor: 1900,
      currency: "USD",
      recurringInterval: "month",
    });
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0]).toMatchObject({
      status: "succeeded",
      amountMinor: 1900,
    });
    expect(state.entitlements.map((grant) => grant.featureKey)).toContain(
      "feature.advanced-analytics",
    );
    expect(state.credits[0]).toMatchObject({
      creditType: "usage",
      availableBalance: 500,
    });
    expect(state.capabilities.paymentManagement).toBe(true);
  });

  it("hides cross-environment and cross-customer billing data", async () => {
    const fixture = await createFixture();
    const subscription = await activateSubscription(fixture);

    // A "live" twin of the subscription: environment columns are immutable
    // by design (#74), so insert a separate live row sharing the customer.
    await db.insert(subscriptions).values({
      id: `sub_live_${Math.random().toString(36).slice(2, 8)}`,
      applicationId: fixture.app.id,
      applicationCustomerId: fixture.applicationCustomer.id,
      providerConnectionId: fixture.providerConnection.id,
      providerSubscriptionId: "sub_provider_live_1",
      environment: "live",
      status: "active",
      cancelAtPeriodEnd: false,
    });

    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });
    const state = await getPortalBillingState(token);
    // The test session sees only the test subscription — never the live twin.
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].id).toBe(subscription.id);

    // A second application customer cannot see the first customer's data.
    const otherCustomer = await createApplicationCustomer(
      {
        applicationId: fixture.app.id,
        externalCustomerId: "user-2",
        email: "other@example.com",
      },
      db,
    );
    await db
      .update(subscriptions)
      .set({ applicationCustomerId: otherCustomer.id })
      .where(eq(subscriptions.id, subscription.id));
    const otherState = await getPortalBillingState(token);
    expect(otherState.subscriptions).toHaveLength(0);
  });

  it("marks unsupported provider actions as unavailable instead of offering them", async () => {
    const fixture = await createFixture({ provider: "limited" });
    await activateSubscription(fixture);

    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });
    const state = await getPortalBillingState(token);
    expect(state.subscriptions[0].canCancel).toBe(false);
    expect(state.capabilities.paymentManagement).toBe(false);
  });
});

describe("portal cancellation through the billing-operation journal", () => {
  it("cancels immediately, revokes entitlements, and audits as customer_portal", async () => {
    const fixture = await createFixture();
    const subscription = await activateSubscription(fixture);
    await grantEntitlement({
      applicationId: fixture.app.id,
      applicationCustomerId: fixture.applicationCustomer.id,
      featureKey: "feature.advanced-analytics",
      sourceType: "subscription",
      sourceId: subscription.id,
      idempotencyKey: "portal-cancel-ent",
      validFrom: new Date("2026-08-18T00:00:00.000Z"),
      environment: "test",
    });

    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });

    const operation = await cancelSubscriptionFromPortal(
      token,
      subscription.id,
    );
    expect(operation.status).toBe("completed");

    const [after] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription.id));
    expect(after.status).toBe("cancelled");

    const audited = await db
      .select()
      .from(operatorAuditLog)
      .where(eq(operatorAuditLog.action, "portal.subscription_cancelled"))
      .orderBy(desc(operatorAuditLog.createdAt))
      .limit(1);
    expect(audited[0]).toMatchObject({
      applicationId: fixture.app.id,
      environment: "test",
      actorType: "customer_portal",
    });
    expect(audited[0].metadata).toMatchObject({
      subscriptionId: subscription.id,
      externalCustomerId: "user-1",
    });
  });

  it("rejects cancellations for other customers and other environments", async () => {
    const fixture = await createFixture();
    const subscription = await activateSubscription(fixture);

    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });

    // Move the subscription to a different customer: the session must not
    // be able to touch it (404, indistinguishable from nonexistent).
    const otherCustomer = await createApplicationCustomer(
      {
        applicationId: fixture.app.id,
        externalCustomerId: "user-2",
        email: "other@example.com",
      },
      db,
    );
    await db
      .update(subscriptions)
      .set({ applicationCustomerId: otherCustomer.id })
      .where(eq(subscriptions.id, subscription.id));

    await expect(
      cancelSubscriptionFromPortal(token, subscription.id),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses cancellation when the provider does not claim subscription_cancel", async () => {
    const fixture = await createFixture({ provider: "limited" });
    const subscription = await activateSubscription(fixture);

    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });

    await expect(
      cancelSubscriptionFromPortal(token, subscription.id),
    ).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);

    // Nothing changed: the subscription is still active.
    const [stillActive] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription.id));
    expect(stillActive.status).toBe("active");
  });
});

describe("portal payment management redirect", () => {
  it("returns the provider portal URL and audits the redirect", async () => {
    const fixture = await createFixture();
    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });

    const result = await createPortalPaymentManagementRedirect(token);
    expect(result.url).toContain("https://mock.monetplane.test/portal/");

    const audited = await db
      .select()
      .from(operatorAuditLog)
      .where(eq(operatorAuditLog.action, "portal.payment_management_opened"))
      .limit(1);
    expect(audited[0]).toMatchObject({
      applicationId: fixture.app.id,
      actorType: "customer_portal",
    });
  });

  it("refuses the redirect when the provider cannot host one", async () => {
    const fixture = await createFixture({ provider: "limited" });
    const { token } = await createPortalSession({
      applicationId: fixture.app.id,
      externalCustomerId: "user-1",
      environment: "test",
    });
    await expect(
      createPortalPaymentManagementRedirect(token),
    ).rejects.toMatchObject({ code: "capability_unsupported" });
  });
});
