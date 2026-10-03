import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
 * Transitional host-only read controls (#127, round-2 hardened):
 * - per-application rate limiting of the branded-host fallback with a
 *   first-breach-only anomaly signal;
 * - XFF is honored ONLY behind MONETPLANE_TRUST_PROXY=true (rotating the
 *   header must not mint buckets); otherwise all host-only clients share
 *   one bucket per application;
 * - the window map is hard-capped and fails closed under key flood;
 * - MONETPLANE_HOST_READ_LIMIT accepts positive integers only.
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

const ENV_KEYS = [
  "MONETPLANE_HOST_READ_LIMIT",
  "MONETPLANE_TRUST_PROXY",
  "MONETPLANE_HOST_READ_MAX_WINDOWS",
] as const;

beforeEach(() => {
  resetHostReadQuotaForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.MONETPLANE_HOST_READ_LIMIT = "3";
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

describe("host-only read rate limiting (#127)", () => {
  it("allows host reads under the limit, 429s above it, and logs the anomaly once per window", async () => {
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
      const fifth = await balancePOST(readRequest({}));
      expect(fourth.status).toBe(429);
      expect(fifth.status).toBe(429);
      await expect(fourth.json()).resolves.toMatchObject({
        code: "rate_limited",
      });
      // First breach of the window only — flood must not become log flood.
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("rate limit exceeded"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rotating x-forwarded-for does not mint buckets when the proxy is untrusted (round-2 P1)", async () => {
    await seedAppWithBalance();
    // MONETPLANE_TRUST_PROXY unset: every client shares ONE bucket/app.
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await balancePOST(
        readRequest({ "x-forwarded-for": `203.0.113.${i}` }),
      );
      results.push(response.status);
    }
    expect(results).toEqual([200, 200, 200, 429, 429]);
  });

  it("distinct clients get distinct buckets behind a trusted proxy", async () => {
    await seedAppWithBalance();
    process.env.MONETPLANE_TRUST_PROXY = "true";

    for (let i = 0; i < 3; i++) {
      const response = await balancePOST(
        readRequest({ "x-forwarded-for": "198.51.100.7" }),
      );
      expect(response.status).toBe(200);
    }
    const fourthSameIp = await balancePOST(
      readRequest({ "x-forwarded-for": "198.51.100.7" }),
    );
    expect(fourthSameIp.status).toBe(429);

    // A different client still has its own bucket.
    const otherClient = await balancePOST(
      readRequest({ "x-forwarded-for": "198.51.100.8" }),
    );
    expect(otherClient.status).toBe(200);
  });

  it("fails closed when the window map hits the hard cap (round-2 P0)", async () => {
    await seedAppWithBalance();
    process.env.MONETPLANE_TRUST_PROXY = "true";
    process.env.MONETPLANE_HOST_READ_MAX_WINDOWS = "3";

    // Fill the map with three distinct live buckets.
    for (let i = 0; i < 3; i++) {
      const response = await balancePOST(
        readRequest({ "x-forwarded-for": `192.0.2.${i}` }),
      );
      expect(response.status).toBe(200);
    }

    // A FOURTH distinct key: map is full and nothing expired -> fail closed,
    // memory cannot grow.
    const newKey = await balancePOST(
      readRequest({ "x-forwarded-for": "192.0.2.99" }),
    );
    expect(newKey.status).toBe(429);

    // Existing buckets keep working within their quota.
    const existingKey = await balancePOST(
      readRequest({ "x-forwarded-for": "192.0.2.0" }),
    );
    expect(existingKey.status).toBe(200);
  });

  it("never limits credential-authenticated reads, even after the host quota is exhausted", async () => {
    const { credentialSecret } = await seedAppWithBalance();

    for (let i = 0; i < 5; i++) {
      const response = await balancePOST(
        readRequest({ authorization: `Bearer ${credentialSecret}` }),
      );
      expect(response.status).toBe(200);
    }

    // Credential reads did not consume host quota.
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

  it("accepts only positive integers for MONETPLANE_HOST_READ_LIMIT", () => {
    const cases: Array<[string | undefined, number]> = [
      ["3", 3],
      ["2.5", 60],
      ["0", 60],
      ["-5", 60],
      ["abc", 60],
      [undefined, 60],
    ];
    for (const [value, expected] of cases) {
      if (value === undefined) {
        delete process.env.MONETPLANE_HOST_READ_LIMIT;
      } else {
        process.env.MONETPLANE_HOST_READ_LIMIT = value;
      }
      expect(hostReadLimitPerMinute()).toBe(expected);
    }
  });
});
