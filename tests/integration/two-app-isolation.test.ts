import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import {
  createApplication,
  issueApplicationCredential,
  registerCallbackOrigin,
} from "../../src/modules/applications/service";
import { grantCredits } from "../../src/modules/credits/service";
import { grantEntitlement } from "../../src/modules/entitlements/service";
import { AuthorizationError } from "../../src/sdk/errors";
import { createMonetPlaneClient } from "../../src/sdk/server";

/**
 * Issue #11 acceptance: two independent applications using the same
 * MonetPlane instance through the same SDK methods, with isolated
 * catalog, customer, entitlement, and credit state.
 *
 * app-a: AI photo generation — credit-based model
 * app-b: SaaS subscription — entitlement-based model
 *
 * The SDK is exercised via a fake fetch that routes to in-process
 * service calls, proving the SDK surface is provider-neutral and
 * the underlying services enforce application isolation.
 */

function createInProcessFetch(appSecret: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const auth =
      init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : (init?.headers as Record<string, string | undefined>)?.authorization;

    // Verify the SDK sends the bearer token
    if (!auth || !auth.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          error: "Missing authorization",
          code: "unauthorized",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    const token = auth.slice(7);
    if (token !== appSecret) {
      return new Response(
        JSON.stringify({ error: "Invalid credential", code: "unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    const db = getDb();

    // Resolve application by credential
    const { authenticateApplicationCredential } = await import(
      "../../src/modules/applications/service"
    );
    const app = await authenticateApplicationCredential(token, db);
    if (!app) {
      return new Response(
        JSON.stringify({ error: "Invalid credential", code: "unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    const applicationId = app.id;

    if (path === "/api/customers" && init?.method === "POST") {
      const { findApplicationCustomer, createApplicationCustomer } =
        await import("../../src/modules/customers/service");
      const existing = await findApplicationCustomer(
        applicationId,
        body.externalCustomerId,
        db,
      );
      if (existing) {
        return new Response(
          JSON.stringify({
            id: existing.id,
            applicationId: existing.applicationId,
            customerId: existing.customerId,
            externalCustomerId: existing.externalCustomerId,
            email: existing.email,
            metadata: existing.metadata,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const customer = await createApplicationCustomer(
        {
          applicationId,
          externalCustomerId: body.externalCustomerId,
          email: body.email ?? null,
          metadata: body.metadata,
        },
        db,
      );
      return new Response(
        JSON.stringify({
          id: customer.id,
          applicationId: customer.applicationId,
          customerId: customer.customerId,
          externalCustomerId: customer.externalCustomerId,
          email: customer.email,
          metadata: customer.metadata,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (path === "/api/credits/balance" && init?.method === "POST") {
      const { getCreditBalance } = await import(
        "../../src/modules/credits/service"
      );
      try {
        const result = await getCreditBalance(
          applicationId,
          body.externalCustomerId,
          body.creditType,
          db,
        );
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "CreditCustomerNotFoundError") {
          return new Response(
            JSON.stringify({
              error: "Customer not found",
              code: "invalid_state",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        throw error;
      }
    }

    if (path === "/api/credits/debit" && init?.method === "POST") {
      const { debitCredits } = await import(
        "../../src/modules/credits/service"
      );
      try {
        const result = await debitCredits(
          {
            applicationId,
            externalCustomerId: body.externalCustomerId,
            creditType: body.creditType,
            amount: body.amount,
            sourceType: body.sourceType,
            sourceId: body.sourceId,
            idempotencyKey: body.idempotencyKey,
            metadata: body.metadata,
          },
          db,
        );
        return new Response(
          JSON.stringify({
            transactionId: result.transaction.id,
            duplicate: result.duplicate,
            availableAfter: result.transaction.availableAfter,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "InsufficientCreditsError") {
          return new Response(
            JSON.stringify({
              error: "Insufficient available credits",
              code: "insufficient_credits",
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        }
        if (name === "CreditCustomerNotFoundError") {
          return new Response(
            JSON.stringify({
              error: "Customer not found",
              code: "invalid_state",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        throw error;
      }
    }

    if (path === "/api/entitlements/check" && init?.method === "POST") {
      const { hasEntitlement } = await import(
        "../../src/modules/entitlements/service"
      );
      const at = body.at ? new Date(body.at as string) : new Date();
      const granted = await hasEntitlement(
        applicationId,
        body.externalCustomerId,
        body.featureKey,
        at,
        db,
      );
      return new Response(JSON.stringify({ granted }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown route: ${path}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function bootstrapApplication(slug: string, name: string) {
  const app = await createApplication({ slug, name }, getDb());
  await registerCallbackOrigin(app.id, "https://app.example.com", getDb());
  const credential = await issueApplicationCredential(
    app.id,
    "sdk-test",
    getDb(),
  );
  return { app, secret: credential.secret };
}

describe("two-application isolation demo", () => {
  it("app-a (credits) and app-b (entitlements) share one SDK surface but never share state", async () => {
    const db = getDb();

    // Bootstrap app-a: AI photo generation (credit-based)
    const { app: appA, secret: secretA } = await bootstrapApplication(
      "ai-photo",
      "AI Photo Generator",
    );

    // Bootstrap app-b: SaaS subscription (entitlement-based)
    const { app: appB, secret: secretB } = await bootstrapApplication(
      "saas-billing",
      "SaaS Billing Demo",
    );

    expect(appA.id).not.toBe(appB.id);

    // SDK clients for both apps
    const clientA = createMonetPlaneClient({
      baseUrl: "https://monetplane.test",
      appSecret: secretA,
      fetchImpl: createInProcessFetch(secretA),
    });

    const clientB = createMonetPlaneClient({
      baseUrl: "https://monetplane.test",
      appSecret: secretB,
      fetchImpl: createInProcessFetch(secretB),
    });

    // app-a: create customer and grant credits
    const customerA = await clientA.upsertCustomer({
      externalCustomerId: "user-a-1",
      email: "user-a@ai-photo.test",
    });
    expect(customerA.applicationId).toBe(appA.id);

    // Grant credits to app-a customer (simulating webhook-driven grant)
    await grantCredits(
      {
        applicationId: appA.id,
        applicationCustomerId: customerA.id,
        creditType: "photo.credits",
        amount: 1000,
        transactionType: "grant.purchase",
        sourceType: "order",
        sourceId: `ord_${randomUUID()}`,
        idempotencyKey: `grant-a-${randomUUID()}`,
      },
      db,
    );

    // app-a: check balance via SDK
    const balanceA = await clientA.getCreditBalance(
      "user-a-1",
      "photo.credits",
    );
    expect(balanceA.available).toBe(1000);

    // app-b: create customer and grant entitlement
    const customerB = await clientB.upsertCustomer({
      externalCustomerId: "user-b-1",
      email: "user-b@saas.test",
    });
    expect(customerB.applicationId).toBe(appB.id);

    await grantEntitlement(
      {
        applicationId: appB.id,
        applicationCustomerId: customerB.id,
        featureKey: "premium.features",
        sourceType: "admin",
        sourceId: `admin_${randomUUID()}`,
        idempotencyKey: `ent-b-${randomUUID()}`,
        validFrom: new Date(),
        validUntil: null,
      },
      db,
    );

    // app-b: check entitlement via SDK
    const entitlementB = await clientB.checkEntitlement({
      externalCustomerId: "user-b-1",
      featureKey: "premium.features",
    });
    expect(entitlementB.granted).toBe(true);

    // === Isolation assertions ===

    // app-a cannot see app-b's customer — getCreditBalance throws for unknown customer
    await expect(
      clientA.getCreditBalance("user-b-1", "photo.credits"),
    ).rejects.toThrow(/Customer not found|Application customer not found/);

    // app-a cannot see app-b's entitlements
    const crossEntitlement = await clientA.checkEntitlement({
      externalCustomerId: "user-b-1",
      featureKey: "premium.features",
    });
    expect(crossEntitlement.granted).toBe(false);

    // app-b cannot debit app-a's credits — customer not found in app-b
    await expect(
      clientB.debitCredits({
        externalCustomerId: "user-a-1",
        creditType: "photo.credits",
        amount: 10,
        sourceType: "job",
        sourceId: "cross-app-job",
        idempotencyKey: "cross-debit-1",
      }),
    ).rejects.toThrow(/Customer not found|Application customer not found/);

    // app-a can debit its own credits
    const debitResult = await clientA.debitCredits({
      externalCustomerId: "user-a-1",
      creditType: "photo.credits",
      amount: 100,
      sourceType: "photo.generate",
      sourceId: "job_001",
      idempotencyKey: "debit-a-1",
    });
    expect(debitResult.duplicate).toBe(false);
    expect(debitResult.availableAfter).toBe(900);

    // app-a idempotent debit returns duplicate=true
    const duplicateDebit = await clientA.debitCredits({
      externalCustomerId: "user-a-1",
      creditType: "photo.credits",
      amount: 100,
      sourceType: "photo.generate",
      sourceId: "job_001",
      idempotencyKey: "debit-a-1",
    });
    expect(duplicateDebit.duplicate).toBe(true);
    expect(duplicateDebit.availableAfter).toBe(900);
  });

  it("rejects SDK calls with wrong app secret", async () => {
    const { secret: secretA } = await bootstrapApplication(
      "isolation-auth",
      "Auth Isolation Test",
    );

    const clientWithWrongSecret = createMonetPlaneClient({
      baseUrl: "https://monetplane.test",
      appSecret: "mp_app_wrong_secret",
      fetchImpl: createInProcessFetch(secretA),
    });

    await expect(
      clientWithWrongSecret.upsertCustomer({
        externalCustomerId: "user-x",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("SDK client method list is provider-neutral", async () => {
    const { secret } = await bootstrapApplication(
      "sdk-surface",
      "SDK Surface Test",
    );

    const client = createMonetPlaneClient({
      baseUrl: "https://monetplane.test",
      appSecret: secret,
      fetchImpl: createInProcessFetch(secret),
    });

    const methods = Object.keys(client).sort();
    expect(methods).toEqual([
      "captureReservation",
      "checkEntitlement",
      "createCheckout",
      "debitCredits",
      "getCreditBalance",
      "releaseReservation",
      "reserveCredits",
      "upsertCustomer",
    ]);

    // Verify no provider-specific properties leak
    for (const key of methods) {
      expect(key).not.toMatch(/creem|waffo|stripe|paypal/i);
    }
  });
});
