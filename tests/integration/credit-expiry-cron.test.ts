import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET, POST } from "../../src/app/api/cron/credit-expiry/route";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import {
  creditBuckets,
  creditTransactions,
} from "../../src/modules/credits/schema";
import {
  getCreditBalance,
  grantCredits,
} from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";

const db = getDb();
const originalSecret = process.env.CRON_SECRET;

afterAll(async () => {
  if (originalSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalSecret;
  }
  await getSqlClient().end({ timeout: 1 });
});

function request(method: "GET" | "POST", authorization?: string) {
  return new Request("http://localhost/api/cron/credit-expiry", {
    method,
    headers: authorization ? { authorization } : {},
  });
}

async function seed() {
  const slug = `cron-x-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1", email: "cron@test" },
    db,
  );
  return { app, customer };
}

async function grant(
  f: Awaited<ReturnType<typeof seed>>,
  options: { amount: number; key: string; expiresAt?: Date | null },
) {
  return grantCredits(
    {
      applicationId: f.app.id,
      applicationCustomerId: f.customer.id,
      creditType: "agent.run",
      amount: options.amount,
      transactionType: options.expiresAt
        ? "grant.subscription"
        : "grant.purchase",
      sourceType: "test",
      sourceId: options.key,
      idempotencyKey: options.key,
      environment: "test",
      expiresAt: options.expiresAt ?? null,
    },
    db,
  );
}

async function bucketsFor(applicationId: string) {
  const buckets = await db
    .select()
    .from(creditBuckets)
    .where(eq(creditBuckets.applicationId, applicationId));
  return new Map(buckets.map((b) => [b.sourceId, b]));
}

describe("credit expiry cron endpoint (B3)", () => {
  it("fails closed with 401 when CRON_SECRET is unset and runs no expiry", async () => {
    delete process.env.CRON_SECRET;
    const f = await seed();
    await grant(f, {
      amount: 25,
      key: "due",
      expiresAt: new Date(Date.now() - 1000),
    });
    await grant(f, { amount: 75, key: "keep" });

    for (const method of ["GET", "POST"] as const) {
      const response = await (method === "GET" ? GET : POST)(request(method));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: "Unauthorized",
      });
    }

    const buckets = await bucketsFor(f.app.id);
    expect(buckets.get("due")).toMatchObject({
      status: "active",
      remainingAmount: 25,
    });
    const balance = await getCreditBalance(
      f.app.id,
      "user-1",
      "agent.run",
      db,
      "test",
    );
    expect(balance.available).toBe(100);
  });

  it("rejects a wrong bearer secret with 401 without expiring anything", async () => {
    process.env.CRON_SECRET = "correct-cron-secret";
    const f = await seed();
    await grant(f, {
      amount: 25,
      key: "due",
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await POST(request("POST", "Bearer wrong-secret"));
    expect(response.status).toBe(401);

    const buckets = await bucketsFor(f.app.id);
    expect(buckets.get("due")).toMatchObject({
      status: "active",
      remainingAmount: 25,
    });
  });

  it("expires due buckets and reports counts for an authorized caller", async () => {
    process.env.CRON_SECRET = "correct-cron-secret";
    const f = await seed();
    const past = new Date(Date.now() - 1000);
    await grant(f, { amount: 25, key: "due-a", expiresAt: past });
    await grant(f, { amount: 10, key: "due-b", expiresAt: past });
    await grant(f, { amount: 65, key: "keep" });

    const response = await POST(
      request("POST", `Bearer ${process.env.CRON_SECRET}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      expiredBuckets: 2,
      expiredAmountMinor: 35,
    });

    const buckets = await bucketsFor(f.app.id);
    expect(buckets.get("due-a")).toMatchObject({
      status: "expired",
      remainingAmount: 0,
    });
    expect(buckets.get("due-b")).toMatchObject({
      status: "expired",
      remainingAmount: 0,
    });
    expect(buckets.get("keep")).toMatchObject({
      status: "active",
      remainingAmount: 65,
    });

    const balance = await getCreditBalance(
      f.app.id,
      "user-1",
      "agent.run",
      db,
      "test",
    );
    expect(balance.available).toBe(65);

    const reversals = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.applicationId, f.app.id),
          eq(creditTransactions.type, "grant.expired"),
        ),
      );
    expect(reversals).toHaveLength(2);
    expect([...reversals].map((r) => r.amount).sort((a, b) => a - b)).toEqual([
      -25, -10,
    ]);

    // Idempotent: a second authorized run finds nothing due.
    const repeat = await GET(
      request("GET", `Bearer ${process.env.CRON_SECRET}`),
    );
    expect(repeat.status).toBe(200);
    await expect(repeat.json()).resolves.toMatchObject({
      expiredBuckets: 0,
      expiredAmountMinor: 0,
    });
  });
});
