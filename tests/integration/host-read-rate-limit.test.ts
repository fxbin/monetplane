import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as balancePOST } from "../../src/app/api/credits/balance/route";
import { POST as checkPOST } from "../../src/app/api/entitlements/check/route";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  hostReadLimitPerMinute,
  resetHostReadQuotaForTests,
} from "../../src/modules/applications/host-read-guards";
import {
  createApplication,
  issueApplicationCredential,
  registerApplicationDomain,
} from "../../src/modules/applications/service";
import { grantCredits } from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";

/**
 * Transitional host-only read controls (#127): balances/entitlements are
 * application-private; the host fallback stays for branded-host surfaces
 * but is rate limited per application+client with an anomaly signal on
 * breach. Credential reads are trusted and never hit the limiter.
 */
const db = getDb();
const HOST = "billing.ratelimit.test";

function readRequest(headers: Record<string, string>): Request {
  return new Request(`https://${HOST}/api/credits/balance`, {
    method: "POST",
    body: JSON.stringify({
      externalCustomerId: "user-1",
      creditType: "gen.credits",
      environment: "test",
    }),
    headers: { host: HOST, "content-type": "application/json", ...headers },
  });
}

async function seedAppWithBalance() {
  const app = await createApplication(
    { slug: `rl-${Math.random().toString(36).slice(2, 8)}`, name: "RL" },
    db,
  );
  await registerApplicationDomain(app.id, HOST, {}, db);
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1" },
    db,
  );
  await grantCredits({
    applicationId: app.id,
    applicationCustomerId: customer.id,
    creditType: "gen.credits",
    amount: 100,
    transactionType: "grant.purchase",
    sourceType: "order",
    sourceId: "seed",
    idempotencyKey: `rl-seed-${app.id}`,
  });
  const credential = await issueApplicationCredential(app.id, "server", db);
  return { app, credentialSecret: credential.secret };
}

beforeEach(() => {
  resetHostReadQuotaForTests();
  process.env.MONETPLANE_HOST_READ_LIMIT = "3";
});

afterAll(async () => {
  delete process.env.MONETPLANE_HOST_READ_LIMIT;
  await getSqlClient().end({ timeout: 1 });
});

describe("host-only read rate limiting (#127)", () => {
  it("allows host reads under the limit and 429s with an anomaly signal above it", async () => {
    await seedAppWithBalance();
    expect(hostReadLimitPerMinute()).toBe(3);

    for (let i = 0; i < 3; i++) {
      const response = await balancePOST(readRequest({}));
      expect(response.status).toBe(200);
    }

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const fourth = await balancePOST(readRequest({}));
      expect(fourth.status).toBe(429);
      await expect(fourth.json()).resolves.toMatchObject({
        code: "rate_limited",
      });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("rate limit exceeded"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("never limits credential-authenticated reads, even after the host quota is exhausted", async () => {
    const { credentialSecret } = await seedAppWithBalance();

    for (let i = 0; i < 5; i++) {
      const response = await balancePOST(
        readRequest({ authorization: `Bearer ${credentialSecret}` }),
      );
      expect(response.status).toBe(200);
    }

    // Host quota untouched by credential reads: 3 host reads still pass.
    for (let i = 0; i < 3; i++) {
      const response = await balancePOST(readRequest({}));
      expect(response.status).toBe(200);
    }
  });

  it("applies the same control to the entitlements check endpoint", async () => {
    await seedAppWithBalance();
    const request = (headers: Record<string, string>) =>
      new Request(`https://${HOST}/api/entitlements/check`, {
        method: "POST",
        body: JSON.stringify({
          externalCustomerId: "user-1",
          featureKey: "feature.pro",
          environment: "test",
        }),
        headers: { host: HOST, "content-type": "application/json", ...headers },
      });

    for (let i = 0; i < 3; i++) {
      const response = await checkPOST(request({}));
      expect(response.status).toBe(200);
    }
    const fourth = await checkPOST(request({}));
    expect(fourth.status).toBe(429);
    await expect(fourth.json()).resolves.toMatchObject({
      code: "rate_limited",
    });
  });
});
