import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import {
  creditAccounts,
  creditBuckets,
} from "../../src/modules/credits/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { parseGrantExpiry } from "../../src/server/control-plane/credit-grant-expiry";
import { grantCustomerCredits } from "../../src/server/control-plane/customer-workspace";
import { setupIntegrationFile } from "./test-setup";

/**
 * Grant expiry plumbing (roundtable 2026-10-06, PR4) + the normalize
 * guardrail: malformed credit types (spaces / uppercase) are normalized by
 * the service, and expiresAt now reaches the bucket row.
 */
const db = getDb();
setupIntegrationFile();

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

async function seed(prefix: string) {
  const app = await createApplication(
    {
      slug: `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
      name: prefix,
    },
    db,
  );
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1" },
    db,
  );
  return { app, customer };
}

async function bucketFor(appId: string, creditType: string) {
  const [account] = await db
    .select({ id: creditAccounts.id })
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.applicationId, appId),
        eq(creditAccounts.creditType, creditType),
        eq(creditAccounts.environment, "test"),
      ),
    )
    .limit(1);
  const [bucket] = await db
    .select({ expiresAt: creditBuckets.expiresAt })
    .from(creditBuckets)
    .where(eq(creditBuckets.creditAccountId, account?.id ?? ""))
    .limit(1);
  return bucket;
}

describe("grant expiry + normalize guardrail", () => {
  it("stores expiresAt on the bucket when provided", async () => {
    const { app, customer } = await seed("exp-grant");
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await grantCustomerCredits(
      app.id,
      customer.id,
      {
        creditType: "agent.run",
        amount: 100,
        idempotencyKey: "exp-1",
        expiresAt,
      },
      "test",
    );
    const bucket = await bucketFor(app.id, "agent.run");
    expect(bucket?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
  });

  it("normalizes a credit type with spaces and uppercase", async () => {
    const { app, customer } = await seed("norm-grant");
    await grantCustomerCredits(
      app.id,
      customer.id,
      { creditType: "  Photo.Credits  ", amount: 10, idempotencyKey: "norm-1" },
      "test",
    );
    // The transaction row carries no creditType (it lives on the account);
    // normalization is proven by the account/bucket existing under the
    // normalized key.
    expect(await bucketFor(app.id, "photo.credits")).toBeTruthy();
    expect(await bucketFor(app.id, "  Photo.Credits  ")).toBeUndefined();
  });

  it("leaves expiresAt null when not provided", async () => {
    const { app, customer } = await seed("noexp-grant");
    await grantCustomerCredits(
      app.id,
      customer.id,
      { creditType: "plain", amount: 10, idempotencyKey: "noexp-1" },
      "test",
    );
    const bucket = await bucketFor(app.id, "plain");
    expect(bucket?.expiresAt).toBeNull();
  });
});

describe("grant expiry input validation (verifier finding)", () => {
  it("rejects an unparseable expiresAt with 400", () => {
    const result = parseGrantExpiry({ expiresAt: "garbage" });
    expect(result.error).not.toBeNull();
    expect(result.error?.status).toBe(400);
  });

  it("rejects a fractional expiresInDays with 400", () => {
    const result = parseGrantExpiry({ expiresInDays: 3.5 });
    expect(result.error?.status).toBe(400);
  });

  it("rejects a non-positive expiresInDays with 400", () => {
    const result = parseGrantExpiry({ expiresInDays: 0 });
    expect(result.error?.status).toBe(400);
  });

  it("accepts an ISO timestamp and whole days", () => {
    const iso = parseGrantExpiry({ expiresAt: "2026-12-01T00:00:00Z" });
    expect(iso.error).toBeNull();
    expect(iso.expiresAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    const days = parseGrantExpiry({ expiresInDays: 30 });
    expect(days.error).toBeNull();
    expect(days.expiresAt).toBeInstanceOf(Date);
  });

  it("returns null expiry when neither field is present", () => {
    const result = parseGrantExpiry({});
    expect(result.error).toBeNull();
    expect(result.expiresAt).toBeNull();
  });
});
