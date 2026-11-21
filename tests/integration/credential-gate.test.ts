import { afterAll, afterEach, describe, expect, it } from "vitest";
import { POST as checkoutPOST } from "../../src/app/api/checkout/route";
import { POST as creditsCapturePOST } from "../../src/app/api/credits/capture/route";
import { POST as creditsDebitPOST } from "../../src/app/api/credits/debit/route";
import { POST as creditsReleasePOST } from "../../src/app/api/credits/release/route";
import { POST as creditsReservePOST } from "../../src/app/api/credits/reserve/route";
import { POST as customersPOST } from "../../src/app/api/customers/route";
import { POST as entitlementsCheckPOST } from "../../src/app/api/entitlements/check/route";
import { POST as portalSessionsPOST } from "../../src/app/api/portal/sessions/route";
import { POST as usageReportPOST } from "../../src/app/api/usage/report/route";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  createApplication,
  issueApplicationCredential,
  registerApplicationDomain,
} from "../../src/modules/applications/service";
import { grantCredits } from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";

// Route-level evidence for the B1 remediation: every money-mutating SDK route
// must answer a Host-only request (no Bearer) with 401 `credential_required`,
// and must let a valid `mp_app_*` credential through to body validation.
// Resolver-level behavior is covered in application-registry.test.ts.
// Fixtures are created inside each test because the integration setup
// truncates the database before every test.

const db = getDb();
const HOST = "billing.gate.test";

const gatedRoutes: Array<[string, (request: Request) => Promise<Response>]> = [
  ["/api/checkout", checkoutPOST],
  ["/api/customers", customersPOST],
  ["/api/credits/debit", creditsDebitPOST],
  ["/api/credits/reserve", creditsReservePOST],
  ["/api/credits/capture", creditsCapturePOST],
  ["/api/credits/release", creditsReleasePOST],
  ["/api/portal/sessions", portalSessionsPOST],
  ["/api/usage/report", usageReportPOST],
];

async function setupGateApp(): Promise<string> {
  const app = await createApplication(
    { slug: "credential-gate", name: "Credential Gate" },
    db,
  );
  await registerApplicationDomain(app.id, HOST, {}, db);
  const credential = await issueApplicationCredential(app.id, "server", db);
  return credential.secret;
}

function post(path: string, headers: Record<string, string>): Request {
  return new Request(`https://${HOST}${path}`, {
    method: "POST",
    body: JSON.stringify({}),
    headers: { host: HOST, "content-type": "application/json", ...headers },
  });
}

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

afterEach(() => {
  delete process.env.MONETPLANE_PUBLIC_URL;
});

describe("money-mutating SDK routes reject host-only requests (B1)", () => {
  it.each(gatedRoutes)(
    "POST %s returns 401 credential_required",
    async (_path, handler) => {
      await setupGateApp();

      const response = await handler(post("/api/checkout", {}));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        code: "credential_required",
      });
    },
  );

  it("lets a valid mp_app credential reach body validation", async () => {
    const secret = await setupGateApp();

    const response = await checkoutPOST(
      post("/api/checkout", { authorization: `Bearer ${secret}` }),
    );

    // Guard passed: the request proceeds to field validation and fails there
    // (missing externalCustomerId/successUrl/cancelUrl), not at auth.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "externalCustomerId, successUrl, and cancelUrl are required",
    });
  });

  it("rejects an invalid credential with 401 unauthorized", async () => {
    await setupGateApp();

    const response = await checkoutPOST(
      post("/api/checkout", { authorization: "Bearer mp_app_notarealsecret" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("API validation and fail-closed hardening", () => {
  it("rejects invalid environment values on checkout and portal session routes with 400", async () => {
    const secret = await setupGateApp();

    const checkoutRes = await checkoutPOST(
      new Request(`https://${HOST}/api/checkout`, {
        method: "POST",
        body: JSON.stringify({
          externalCustomerId: "user-1",
          items: [{ priceId: "price_1", quantity: 1 }],
          successUrl: "https://app.test/ok",
          cancelUrl: "https://app.test/cancel",
          environment: "prod",
        }),
        headers: {
          host: HOST,
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
      }),
    );
    expect(checkoutRes.status).toBe(400);
    await expect(checkoutRes.json()).resolves.toMatchObject({
      code: "invalid_environment",
    });

    const portalRes = await portalSessionsPOST(
      new Request(`https://${HOST}/api/portal/sessions`, {
        method: "POST",
        body: JSON.stringify({
          externalCustomerId: "user-1",
          environment: "production",
        }),
        headers: {
          host: HOST,
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
      }),
    );
    expect(portalRes.status).toBe(400);
    await expect(portalRes.json()).resolves.toMatchObject({
      code: "invalid_environment",
    });
  });

  it("uses MONETPLANE_PUBLIC_URL and sets Cache-Control: no-store on portal session creation", async () => {
    process.env.MONETPLANE_PUBLIC_URL = "https://portal.public.test/ignored";
    const app = await createApplication(
      { slug: "portal-origin", name: "Portal Origin" },
      db,
    );
    const credential = await issueApplicationCredential(app.id, "server", db);
    await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "cust-1" },
      db,
    );

    const res = await portalSessionsPOST(
      new Request("http://0.0.0.0:3000/api/portal/sessions", {
        method: "POST",
        body: JSON.stringify({
          externalCustomerId: "cust-1",
          environment: "live",
        }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.secret}`,
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as { portalUrl: string };
    expect(json.portalUrl).toMatch(
      /^https:\/\/portal\.public\.test\/portal\?token=mptok_/,
    );
  });

  it("validates entitlement check historical timestamp `at` and blocks non-credential usage", async () => {
    const secret = await setupGateApp();

    const badDateRes = await entitlementsCheckPOST(
      new Request(`https://${HOST}/api/entitlements/check`, {
        method: "POST",
        body: JSON.stringify({
          externalCustomerId: "user-1",
          featureKey: "pro",
          at: "not-a-timestamp",
        }),
        headers: {
          host: HOST,
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
      }),
    );
    expect(badDateRes.status).toBe(400);
    await expect(badDateRes.json()).resolves.toMatchObject({
      code: "invalid_request",
    });

    const hostHistoryRes = await entitlementsCheckPOST(
      new Request(`https://${HOST}/api/entitlements/check`, {
        method: "POST",
        body: JSON.stringify({
          externalCustomerId: "user-1",
          featureKey: "pro",
          at: new Date().toISOString(),
        }),
        headers: {
          host: HOST,
          "content-type": "application/json",
        },
      }),
    );
    expect(hostHistoryRes.status).toBe(400);
    await expect(hostHistoryRes.json()).resolves.toMatchObject({
      code: "invalid_request",
    });
  });

  it("returns 402 insufficient_credits (not 500) when debiting against an expired credit bucket", async () => {
    const app = await createApplication(
      { slug: "debit-expired-402", name: "Debit Expired 402" },
      db,
    );
    const credential = await issueApplicationCredential(app.id, "server", db);
    const customer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "user-exp" },
      db,
    );
    await grantCredits(
      {
        applicationId: app.id,
        applicationCustomerId: customer.id,
        creditType: "tokens",
        amount: 50,
        transactionType: "grant.promotion",
        sourceType: "test",
        sourceId: "seed",
        idempotencyKey: "exp-seed-1",
        environment: "test",
        expiresAt: new Date(Date.now() - 10_000),
      },
      db,
    );

    const debitRes = await creditsDebitPOST(
      new Request("https://api.test/api/credits/debit", {
        method: "POST",
        body: JSON.stringify({
          externalCustomerId: "user-exp",
          creditType: "tokens",
          amount: 10,
          sourceType: "job",
          sourceId: "job-1",
          idempotencyKey: "debit-exp-1",
          environment: "test",
        }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.secret}`,
        },
      }),
    );
    expect(debitRes.status).toBe(402);
    await expect(debitRes.json()).resolves.toMatchObject({
      code: "insufficient_credits",
    });
  });
});
