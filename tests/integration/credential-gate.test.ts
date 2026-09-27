import { afterAll, describe, expect, it } from "vitest";
import { POST as checkoutPOST } from "../../src/app/api/checkout/route";
import { POST as creditsCapturePOST } from "../../src/app/api/credits/capture/route";
import { POST as creditsDebitPOST } from "../../src/app/api/credits/debit/route";
import { POST as creditsReleasePOST } from "../../src/app/api/credits/release/route";
import { POST as creditsReservePOST } from "../../src/app/api/credits/reserve/route";
import { POST as customersPOST } from "../../src/app/api/customers/route";
import { POST as portalSessionsPOST } from "../../src/app/api/portal/sessions/route";
import { POST as usageReportPOST } from "../../src/app/api/usage/report/route";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  createApplication,
  issueApplicationCredential,
  registerApplicationDomain,
} from "../../src/modules/applications/service";

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
