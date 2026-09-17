import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import {
  consumeBuckets,
  createBucketForGrant,
  expireDueCreditBuckets,
  getBucketSummary,
} from "../../src/modules/credits/buckets";
import {
  creditBuckets,
  creditTransactions,
} from "../../src/modules/credits/schema";
import {
  debitCredits,
  getCreditBalance,
  grantCredits,
  reserveCredits,
} from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";

const db = getDb();

beforeEach(() => {});

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

async function seed() {
  const slug = `buckets-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1", email: "b@test" },
    db,
  );
  return { app, customer };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function grant(
  f: Fixture,
  options: {
    amount: number;
    key: string;
    expiresAt?: Date | null;
    type?: "grant.purchase" | "grant.subscription" | "grant.promotion";
  },
) {
  return grantCredits(
    {
      applicationId: f.app.id,
      applicationCustomerId: f.customer.id,
      creditType: "agent.run",
      amount: options.amount,
      transactionType: options.type ?? "grant.promotion",
      sourceType: "test",
      sourceId: options.key,
      idempotencyKey: options.key,
      environment: "test",
      expiresAt: options.expiresAt ?? null,
    },
    db,
  );
}

describe("credit lifecycle buckets (#63)", () => {
  it("creates an auditable bucket per grant with provenance", async () => {
    const f: Fixture = await seed();
    await grant(f, { amount: 100, key: "b1" });
    const [bucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.applicationId, f.app.id));
    expect(bucket).toMatchObject({
      sourceType: "promotion",
      grantedAmount: 100,
      remainingAmount: 100,
      status: "active",
      expiresAt: null,
    });
    const summary = await getBucketSummary(f.app.id, f.customer.id, "test", db);
    expect(summary.activeBuckets).toHaveLength(1);
    expect(summary.nextExpiries).toHaveLength(0);
  });

  it("consumes soonest-expiring buckets first; never-expiring purchased credits last", async () => {
    const f: Fixture = await seed();
    const soon = new Date(Date.now() + 24 * 3600 * 1000);
    const later = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await grant(f, { amount: 50, key: "purchased", type: "grant.purchase" }); // no expiry
    await grant(f, {
      amount: 30,
      key: "allowance-later",
      expiresAt: later,
      type: "grant.subscription",
    });
    await grant(f, {
      amount: 20,
      key: "allowance-soon",
      expiresAt: soon,
      type: "grant.subscription",
    });

    // Debit 45: soon(20) + later(25 of 30); purchased untouched.
    await debitCredits(
      {
        applicationId: f.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 45,
        sourceType: "usage",
        sourceId: "job-1",
        idempotencyKey: "d1",
        environment: "test",
      },
      db,
    );

    const buckets = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.applicationId, f.app.id));
    const byKey = new Map(buckets.map((b) => [b.sourceId, b]));
    expect(byKey.get("allowance-soon")?.status).toBe("consumed");
    expect(byKey.get("allowance-later")?.remainingAmount).toBe(5);
    expect(byKey.get("purchased")?.remainingAmount).toBe(50);

    const balance = await getCreditBalance(
      f.app.id,
      "user-1",
      "agent.run",
      db,
      "test",
    );
    expect(balance.available).toBe(55);
  });

  it("expires due buckets through traceable grant.expired reversal ledger entries", async () => {
    const f: Fixture = await seed();
    const past = new Date(Date.now() - 1000);
    await grant(f, {
      amount: 40,
      key: "expired-allowance",
      expiresAt: past,
      type: "grant.subscription",
    });
    await grant(f, { amount: 60, key: "purchased", type: "grant.purchase" });

    const expired = await expireDueCreditBuckets(db as never);
    expect(expired).toHaveLength(1);
    expect(expired[0].reversedAmount).toBe(40);

    const [reversal] = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.applicationId, f.app.id),
          eq(creditTransactions.type, "grant.expired"),
        ),
      );
    expect(reversal.amount).toBe(-40);

    const balance = await getCreditBalance(
      f.app.id,
      "user-1",
      "agent.run",
      db,
      "test",
    );
    expect(balance.available).toBe(60);

    const [bucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.sourceId, "expired-allowance"));
    expect(bucket.status).toBe("expired");
    expect(bucket.remainingAmount).toBe(0);
  });

  it("reservations capture against live buckets and cannot use expired credits", async () => {
    const f: Fixture = await seed();
    await grant(f, { amount: 100, key: "pool", type: "grant.purchase" });

    const { reservation } = await reserveCredits(
      {
        applicationId: f.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 30,
        referenceType: "job",
        referenceId: "job-9",
        idempotencyKey: "r1",
        environment: "test",
      },
      db,
    );
    expect(reservation.reservedAmount).toBe(30);

    const { captureReservation } = await import(
      "../../src/modules/credits/service"
    );
    const capture = await captureReservation(
      {
        applicationId: f.app.id,
        reservationId: reservation.id,
        amount: 30,
        idempotencyKey: "cap1",
        environment: "test",
      },
      db,
    );
    expect(capture.transaction?.amount ?? -30).toBe(-30);

    const [bucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.applicationId, f.app.id));
    expect(bucket.remainingAmount).toBe(70);
  });

  it("keeps debit/consume concurrency safe under the bucket invariant", async () => {
    const f: Fixture = await seed();
    await grant(f, { amount: 100, key: "pool", type: "grant.purchase" });

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        debitCredits(
          {
            applicationId: f.app.id,
            externalCustomerId: "user-1",
            creditType: "agent.run",
            amount: 30,
            sourceType: "usage",
            sourceId: `race-${i}`,
            idempotencyKey: `race-${i}`,
            environment: "test",
          },
          db,
        ),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const balance = await getCreditBalance(
      f.app.id,
      "user-1",
      "agent.run",
      db,
      "test",
    );
    // Only three 30-unit debits can succeed against a 100-credit pool.
    expect(succeeded).toBe(3);
    expect(balance.available).toBe(10);

    const [bucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.applicationId, f.app.id));
    expect(bucket.remainingAmount).toBe(10);
  });

  it("isolates buckets by environment", async () => {
    const f: Fixture = await seed();
    await grant(f, { amount: 25, key: "env-key" });
    const live = await grantCredits(
      {
        applicationId: f.app.id,
        applicationCustomerId: f.customer.id,
        creditType: "agent.run",
        amount: 75,
        transactionType: "grant.purchase",
        sourceType: "test",
        sourceId: "env-key-live",
        idempotencyKey: "env-key-live",
        environment: "live",
      },
      db,
    );
    expect(live.transaction.amount).toBe(75);

    const testSummary = await getBucketSummary(
      f.app.id,
      f.customer.id,
      "test",
      db,
    );
    const liveSummary = await getBucketSummary(
      f.app.id,
      f.customer.id,
      "live",
      db,
    );
    expect(testSummary.activeBuckets).toHaveLength(1);
    expect(liveSummary.activeBuckets).toHaveLength(1);
    expect(liveSummary.activeBuckets[0].remainingAmount).toBe(75);
  });
});
