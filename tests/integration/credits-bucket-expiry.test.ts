import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { expireDueCreditBuckets } from "../../src/modules/credits/buckets";
import {
  creditAccounts,
  creditBuckets,
} from "../../src/modules/credits/schema";
import {
  captureReservation,
  grantCredits,
  releaseReservation,
  reserveCredits,
} from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { setupIntegrationFile } from "./test-setup";

/**
 * Bucket-expiry × reservation interaction (roundtable 2026-10-06, PR-A).
 * The two accounting defects being pinned:
 *  1. expiry decremented only availableBalance (clamped), breaking
 *     sum(active bucket remaining) == available + reserved;
 *  2. releasing a reservation afterwards revived the expired credits.
 * Fix: accounts with reservedBalance > 0 defer bucket expiry until the
 * reservations settle.
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

async function accountOf(appId: string, creditType: string) {
  const [account] = await db
    .select()
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.applicationId, appId),
        eq(creditAccounts.creditType, creditType),
        eq(creditAccounts.environment, "test"),
      ),
    )
    .limit(1);
  return account;
}

async function invariantHolds(appId: string, creditType: string) {
  const account = await accountOf(appId, creditType);
  const buckets = await db
    .select({
      remaining: creditBuckets.remainingAmount,
      status: creditBuckets.status,
    })
    .from(creditBuckets)
    .where(eq(creditBuckets.creditAccountId, account?.id ?? ""));
  const activeSum = buckets
    .filter((b) => b.status === "active")
    .reduce((sum, b) => sum + b.remaining, 0);
  return (
    activeSum ===
    (account?.availableBalance ?? 0) + (account?.reservedBalance ?? 0)
  );
}

describe("bucket expiry defers while reservations are open (PR-A)", () => {
  it("does not expire a bucket backing an open reservation, then expires after release without reviving credits", async () => {
    const { app, customer } = await seed("exp-reserve");
    const past = new Date(Date.now() - 1000);
    await grantCredits(
      {
        applicationId: app.id,
        applicationCustomerId: customer.id,
        creditType: "tokens",
        amount: 100,
        transactionType: "grant.promotion",
        sourceType: "test",
        sourceId: "seed",
        idempotencyKey: "g1",
        expiresAt: past,
      },
      db,
    );

    // Reserve 30: available=70, reserved=30; the bucket still backs both.
    const { reservation } = await reserveCredits(
      {
        applicationId: app.id,
        externalCustomerId: "user-1",
        creditType: "tokens",
        amount: 30,
        referenceType: "job",
        referenceId: "j1",
        idempotencyKey: "r1",
      },
      db,
    );

    // Expiry sweep must SKIP this account (reserved > 0).
    await expireDueCreditBuckets(db, new Date());
    let account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(70);
    expect(account?.reservedBalance).toBe(30);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);

    // Release the reservation: available back to 100, still backed by the
    // (overdue) active bucket.
    await releaseReservation(
      {
        applicationId: app.id,
        reservationId: reservation.id,
        idempotencyKey: "rel1",
      },
      db,
    );
    account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(100);

    // Next sweep expires the bucket cleanly — and the earlier release did
    // NOT revive anything: the reversal is the full grant amount.
    const result = await expireDueCreditBuckets(db, new Date());
    expect(result).toHaveLength(1);
    expect(result[0]?.reversedAmount).toBe(100);
    account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(0);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);
  });

  it("expires normally once a reservation is captured before the sweep", async () => {
    const { app, customer } = await seed("exp-capture");
    const past = new Date(Date.now() - 1000);
    await grantCredits(
      {
        applicationId: app.id,
        applicationCustomerId: customer.id,
        creditType: "tokens",
        amount: 50,
        transactionType: "grant.promotion",
        sourceType: "test",
        sourceId: "seed",
        idempotencyKey: "g1",
        expiresAt: past,
      },
      db,
    );
    const { reservation } = await reserveCredits(
      {
        applicationId: app.id,
        externalCustomerId: "user-1",
        creditType: "tokens",
        amount: 20,
        referenceType: "job",
        referenceId: "j2",
        idempotencyKey: "r2",
      },
      db,
    );
    await captureReservation(
      {
        applicationId: app.id,
        reservationId: reservation.id,
        amount: 20,
        idempotencyKey: "c2",
      },
      db,
    );

    // reserved==0 now; the sweep expires the remaining 30.
    const result = await expireDueCreditBuckets(db, new Date());
    expect(result).toHaveLength(1);
    expect(result[0]?.reversedAmount).toBe(30);
    const account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(0);
    expect(account?.reservedBalance).toBe(0);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);
  });
});
