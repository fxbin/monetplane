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
  debitCredits,
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

describe("partial expiry with open reservations (external review P0 fix)", () => {
  it("expires the available portion immediately; expired credits are NOT spendable; residual settles after release", async () => {
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

    // Reserve 30: available=70, reserved=30; the bucket backs both.
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

    // Sweep: the AVAILABLE 70 expires now (partial expiry), the
    // reserved-backed 30 stays as an active residual.
    const result = await expireDueCreditBuckets(db, new Date());
    expect(result).toHaveLength(1);
    expect(result[0]?.reversedAmount).toBe(70);

    let account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(0);
    expect(account?.reservedBalance).toBe(30);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);

    // P0 discriminator: the expired 70 must NOT be spendable — even a
    // 1-credit debit fails now (this was the hole the whole-account skip
    // left open).
    await expect(
      debitCredits(
        {
          applicationId: app.id,
          externalCustomerId: "user-1",
          creditType: "tokens",
          amount: 1,
          sourceType: "test",
          sourceId: "post-expiry",
          idempotencyKey: "d-post",
        },
        db,
      ),
    ).rejects.toThrow();

    // The reservation still settles normally against the residual...
    await captureReservation(
      {
        applicationId: app.id,
        reservationId: reservation.id,
        amount: 30,
        idempotencyKey: "c1",
      },
      db,
    );
    account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(0);
    expect(account?.reservedBalance).toBe(0);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);

    // ...and a final sweep retires whatever remains.
    await expireDueCreditBuckets(db, new Date());
    account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(0);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);
  });

  it("released-back credits on an expired bucket are refused by consumption and retired by the next sweep", async () => {
    const { app, customer } = await seed("exp-release");
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

    // Partial expiry takes the available 30.
    await expireDueCreditBuckets(db, new Date());

    // Release the reservation: the 20 lands on an already-expired bucket.
    await releaseReservation(
      {
        applicationId: app.id,
        reservationId: reservation.id,
        idempotencyKey: "rel2",
      },
      db,
    );
    // The release itself restored available (account mechanics), but the
    // money sits on an expired bucket: consumption must refuse it...
    await expect(
      debitCredits(
        {
          applicationId: app.id,
          externalCustomerId: "user-1",
          creditType: "tokens",
          amount: 1,
          sourceType: "test",
          sourceId: "post-release",
          idempotencyKey: "d-rel",
        },
        db,
      ),
    ).rejects.toThrow();

    // ...and the next sweep retires the released-back residual with its
    // own monotonic stage entry (no idempotency collision with stage 1).
    const second = await expireDueCreditBuckets(db, new Date());
    expect(second).toHaveLength(1);
    expect(second[0]?.reversedAmount).toBe(20);

    const account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(0);
    expect(account?.reservedBalance).toBe(0);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);
  });
});
