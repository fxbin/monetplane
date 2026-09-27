import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as customerRefundPOST } from "../../src/app/api/admin/customers/[customerId]/payments/[paymentId]/refund/route";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import {
  orderItems,
  orders,
  payments,
  subscriptionItems,
  subscriptions,
} from "../../src/modules/commerce/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { operatorAuditLog } from "../../src/modules/operations/audit-schema";
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
  acceptInvitation,
  findMembershipByEmail,
  inviteMember,
} from "../../src/modules/team/service";
import {
  correlationIdFrom,
  listAuditEntries,
  recordAuditEntry,
  redactAuditMetadata,
} from "../../src/server/control-plane/audit";
import {
  cancelSubscriptionWithJournal,
  refundPaymentWithJournal,
} from "../../src/server/control-plane/billing-operation-actions";

/**
 * The customer-scoped refund route (audit A4 regression) exercises the admin
 * guard and console context, so the NextAuth session and request cookies are
 * mocked the same way as team-access.test.ts; membership data stays real in
 * the database.
 */
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: vi.fn(),
  draftMode: vi.fn(),
}));

const { auth } = await import("@/auth");
const mockAuth = vi.mocked(auth);
const { cookies } = await import("next/headers");
const mockCookies = vi.mocked(cookies);

const db = getDb();

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

describe("operator audit log (#66)", () => {
  it("records immutable, application-scoped audit entries with actor and correlation id", async () => {
    const slug = `audit-${Math.random().toString(36).slice(2, 8)}`;
    const app = await createApplication({ slug, name: slug }, db);

    const entry = await recordAuditEntry(
      {
        applicationId: app.id,
        environment: "test",
        action: "api_key.created",
        resourceType: "application_credential",
        resourceId: "cred_test_1",
        metadata: { name: "prod", secretPrefix: "mp_app_ABCD" },
        actor: { id: "admin@example.com", label: "Admin" },
        request: new Request("https://console.test/api", {
          headers: { "x-monetplane-request-id": "req_12345678" },
        }),
      },
      db,
    );

    expect(entry).toMatchObject({
      applicationId: app.id,
      environment: "test",
      actorId: "admin@example.com",
      action: "api_key.created",
      correlationId: "req_12345678",
    });
    // Secret-ish keys keep their name but never their value.
    expect(entry.metadata).toMatchObject({
      name: "prod",
      secretPrefix: "[redacted]",
    });
    expect(
      redactAuditMetadata({
        apiKeySecret: "mp_app_super",
        webhookSecret: "whsec_x",
      }),
    ).toEqual({
      apiKeySecret: "[redacted]",
      webhookSecret: "[redacted]",
    });

    // Append-only: UPDATE and DELETE fail at the database level.
    await expect(
      db
        .update(operatorAuditLog)
        .set({ action: "tampered" })
        .where(eq(operatorAuditLog.id, entry.id)),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.delete(operatorAuditLog).where(eq(operatorAuditLog.id, entry.id)),
    ).rejects.toThrow(/append-only/i);
  });

  it("deep-redacts nested secrets and truncates long values", () => {
    const redacted = redactAuditMetadata({
      name: "primary",
      providerPayload: {
        apiKey: "sk_live_abc",
        nested: { signingSecret: "x" },
      },
      note: "a".repeat(500),
    });
    // Whole credential-like containers redact wholesale (coarse but safe);
    // secret-ish leaf keys redact by value.
    expect(redacted).toEqual({
      name: "primary",
      providerPayload: {
        apiKey: "[redacted]",
        nested: { signingSecret: "[redacted]" },
      },
      note: expect.stringContaining("…"),
    });
  });

  it("scopes audit reads to the application (cross-app access fails closed)", async () => {
    const slugA = `audit-a-${Math.random().toString(36).slice(2, 6)}`;
    const slugB = `audit-b-${Math.random().toString(36).slice(2, 6)}`;
    const appA = await createApplication({ slug: slugA, name: slugA }, db);
    const appB = await createApplication({ slug: slugB, name: slugB }, db);

    await recordAuditEntry(
      {
        applicationId: appA.id,
        action: "credits.granted",
        resourceType: "credit_transaction",
        resourceId: "ctx_1",
        actor: { id: "admin" },
      },
      db,
    );

    const listA = await listAuditEntries(appA.id, {}, db);
    const listB = await listAuditEntries(appB.id, {}, db);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(0);
  });

  it("filters by action, actor, environment, and date", async () => {
    const slug = `audit-f-${Math.random().toString(36).slice(2, 6)}`;
    const app = await createApplication({ slug, name: slug }, db);
    await recordAuditEntry(
      {
        applicationId: app.id,
        environment: "live",
        action: "provider.connected",
        resourceType: "provider_connection",
        resourceId: "pconn_1",
        actor: { id: "alice" },
      },
      db,
    );
    await recordAuditEntry(
      {
        applicationId: app.id,
        environment: "test",
        action: "provider.revoked",
        resourceType: "provider_connection",
        resourceId: "pconn_2",
        actor: { id: "bob" },
      },
      db,
    );

    const live = await listAuditEntries(app.id, { environment: "live" }, db);
    expect(live.map((e) => e.action)).toEqual(["provider.connected"]);
    const byActor = await listAuditEntries(app.id, { actor: "bob" }, db);
    expect(byActor.map((e) => e.action)).toEqual(["provider.revoked"]);
    const none = await listAuditEntries(
      app.id,
      { from: new Date(Date.now() + 60_000) },
      db,
    );
    expect(none).toHaveLength(0);
  });

  it("generates safe correlation ids", () => {
    expect(correlationIdFrom(undefined)).toMatch(/^req_[0-9a-f-]{8,}$/);
    expect(correlationIdFrom(new Request("https://x.test", {}))).toMatch(
      /^req_/,
    );
    const hostile = new Request("https://x.test", {
      headers: { "x-monetplane-request-id": "bad value; drop table" },
    });
    expect(correlationIdFrom(hostile)).toMatch(/^req_/);
  });

  it("records environment-sensitive actions with the effective environment", async () => {
    const slug = `audit-e-${Math.random().toString(36).slice(2, 6)}`;
    const app = await createApplication({ slug, name: slug }, db);
    await recordAuditEntry(
      {
        applicationId: app.id,
        environment: "live",
        action: "webhook_endpoint.created",
        resourceType: "webhook_endpoint",
        resourceId: "whep_1",
        actor: { id: "admin" },
      },
      db,
    );
    const [row] = await db
      .select()
      .from(operatorAuditLog)
      .where(and(eq(operatorAuditLog.applicationId, app.id)));
    expect(row.environment).toBe("live");
  });
});

/**
 * Audit A4: journaled refund and cancel operations own their operator audit
 * entry, written in the same transaction that completes the journal row —
 * so every twin route (payment-scoped and customer-scoped) produces exactly
 * one operation audit, and failures never produce a success entry.
 */
describe("journaled billing operation audit (A4)", () => {
  const encryptionKey = Buffer.from(
    "0123456789abcdef0123456789abcdef",
    "utf8",
  ).toString("base64");

  let refundBehavior: "success" | "reject" = "success";

  const auditAdapter: PaymentProviderAdapter = {
    ...mockProviderAdapter,
    provider: "audit-test",
    async refundPayment(connection, input) {
      if (refundBehavior === "reject") {
        throw new ProviderOperationError(
          "provider rejected request",
          "rejected",
        );
      }
      return mockProviderAdapter.refundPayment(connection, input);
    },
  };

  beforeEach(() => {
    process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
    refundBehavior = "success";
    clearProviderAdaptersForTests();
    registerProviderAdapter(auditAdapter);
    mockAuth.mockReset();
  });

  afterAll(() => {
    delete process.env.MONETPLANE_ENCRYPTION_KEY;
    clearProviderAdaptersForTests();
  });

  async function auditEntriesFor(applicationId: string) {
    return db
      .select()
      .from(operatorAuditLog)
      .where(eq(operatorAuditLog.applicationId, applicationId));
  }

  async function seedRefundablePayment(suffix: string) {
    const app = await createApplication(
      { slug: `audit-ops-${suffix}`, name: `Audit Ops ${suffix}` },
      db,
    );
    const customer = await createApplicationCustomer(
      {
        applicationId: app.id,
        externalCustomerId: `audit-user-${suffix}`,
        email: `${suffix}@example.com`,
      },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "audit-test",
        name: `audit-${suffix}`,
        mode: "test",
        credentials: { apiKey: "test-key", webhookSecret: "test-secret" },
      },
      db,
    );
    const product = await createProduct(
      {
        applicationId: app.id,
        key: `product-${suffix}`,
        name: `Product ${suffix}`,
      },
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
    const orderId = `ord_audit_${suffix}`;
    const paymentId = `pay_audit_${suffix}`;
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
      id: `item_audit_${suffix}`,
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
      providerPaymentId: `provider_payment_audit_${suffix}`,
      status: "succeeded",
      amountMinor: 4900,
      currency: "USD",
    });
    return { app, customer, connection, paymentId };
  }

  async function seedCancellableSubscription(suffix: string) {
    const app = await createApplication(
      { slug: `audit-cancel-${suffix}`, name: `Audit Cancel ${suffix}` },
      db,
    );
    const customer = await createApplicationCustomer(
      {
        applicationId: app.id,
        externalCustomerId: `audit-sub-user-${suffix}`,
        email: `${suffix}@example.com`,
      },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "audit-test",
        name: `audit-sub-${suffix}`,
        mode: "test",
        credentials: { apiKey: "test-key", webhookSecret: "test-secret" },
      },
      db,
    );
    const product = await createProduct(
      { applicationId: app.id, key: `pro-${suffix}`, name: `Pro ${suffix}` },
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
    const subscriptionId = `sub_audit_${suffix}`;
    await db.insert(subscriptions).values({
      id: subscriptionId,
      applicationId: app.id,
      applicationCustomerId: customer.id,
      providerConnectionId: connection.id,
      providerSubscriptionId: `provider_sub_audit_${suffix}`,
      status: "active",
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    await db.insert(subscriptionItems).values({
      id: `subitem_audit_${suffix}`,
      subscriptionId,
      productId: product.id,
      priceId: price.id,
      quantity: 1,
      unitAmountMinor: 1900,
      currency: "USD",
    });
    return { app, subscriptionId };
  }

  it("journaled refund writes exactly one audit entry with the operator actor", async () => {
    const seed = await seedRefundablePayment("refund");

    const operation = await refundPaymentWithJournal(
      seed.app.id,
      seed.paymentId,
      "test",
      { id: "op_refunder", label: "Rita Refunder" },
    );
    expect(operation.status).toBe("completed");

    const entries = await auditEntriesFor(seed.app.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      applicationId: seed.app.id,
      environment: "test",
      action: "payment.refunded",
      resourceType: "billing_operation",
      resourceId: operation.id,
      actorType: "admin_session",
      actorId: "op_refunder",
      actorLabel: "Rita Refunder",
      metadata: { paymentId: seed.paymentId },
    });
  });

  it("journaled cancellation writes its audit entry with the operator actor", async () => {
    const seed = await seedCancellableSubscription("cancel");

    const operation = await cancelSubscriptionWithJournal(
      seed.app.id,
      seed.subscriptionId,
      "test",
      { id: "op_canceller", label: "Carl Canceller" },
    );
    expect(operation.status).toBe("completed");

    const entries = await auditEntriesFor(seed.app.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      applicationId: seed.app.id,
      environment: "test",
      action: "subscription.cancelled",
      resourceType: "billing_operation",
      resourceId: operation.id,
      actorType: "admin_session",
      actorId: "op_canceller",
      actorLabel: "Carl Canceller",
      metadata: { subscriptionId: seed.subscriptionId },
    });
  });

  it("a rejected provider attempt journals the failure but writes no success audit entry", async () => {
    const seed = await seedRefundablePayment("failure");
    refundBehavior = "reject";

    await expect(
      refundPaymentWithJournal(seed.app.id, seed.paymentId, "test", {
        id: "op_refunder",
        label: "Rita Refunder",
      }),
    ).rejects.toThrow("provider rejected request");

    const [operation] = await db
      .select()
      .from(billingOperations)
      .where(eq(billingOperations.resourceId, seed.paymentId));
    expect(operation?.status).toBe("failed");

    // No audit entry: the audit only commits with journal completion.
    expect(await auditEntriesFor(seed.app.id)).toHaveLength(0);
  });

  it("customer-scoped refund route records the audit entry via the journaled operation (A4 regression)", async () => {
    const email = `route-admin-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.test`;
    const { token } = await inviteMember({
      email,
      role: "owner",
      applicationScope: "all",
      applicationIds: [],
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await acceptInvitation({
      token,
      name: "Route Admin",
      password: "must(sup3rsecret)",
    });
    const membership = await findMembershipByEmail(email);
    if (!membership) throw new Error("membership missing after accept");

    mockAuth.mockResolvedValue({
      user: { id: membership.operatorId },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    } as never);
    mockCookies.mockResolvedValue({ get: () => undefined } as never);

    const seed = await seedRefundablePayment("route");

    const response = await customerRefundPOST(
      new Request(
        "https://console.test/api/admin/customers/c/payments/p/refund",
        { method: "POST" },
      ),
      {
        params: Promise.resolve({
          customerId: seed.customer.id,
          paymentId: seed.paymentId,
        }),
      },
    );
    expect(response.status).toBe(200);

    const entries = await auditEntriesFor(seed.app.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      applicationId: seed.app.id,
      action: "payment.refunded",
      resourceType: "billing_operation",
      actorType: "admin_session",
      actorId: membership.operatorId,
      actorLabel: "Route Admin",
      metadata: { paymentId: seed.paymentId },
    });
  });
});
