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
  it("grandfathers a reservation made BEFORE expiry: sweep takes only the available portion, capture settles the residual (round-2 A)", async () => {
    const { app, customer } = await seed("exp-predate");
    // Future expiry so the reservation genuinely predates it.
    const expiry = new Date(Date.now() + 2000);
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
        expiresAt: expiry,
      },
      db,
    );

    // Reserve 30 while the bucket is live: available=70, reserved=30.
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

    // Wait past expiry, then sweep: the AVAILABLE 70 expires, the
    // reserved-backed 30 stays as an active residual.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const result = await expireDueCreditBuckets(db, new Date());
    expect(result).toHaveLength(1);
    expect(result[0]?.reversedAmount).toBe(70);

    let account = await accountOf(app.id, "tokens");
    expect(account?.availableBalance).toBe(0);
    expect(account?.reservedBalance).toBe(30);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);

    // Expired 70 not spendable via debit.
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

    // Pre-expiry reservation settles against the residual (grandfather).
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
  });

  it("refuses a reservation made AFTER expiry — the reserve→capture bypass is closed (round-2 B / P0)", async () => {
    const { app, customer } = await seed("exp-postdate");
    const past = new Date(Date.now() - 5000);
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
    // No sweep yet: the bucket is overdue but the account balance still
    // nominally shows 100. The round-2 fix runs an account-scoped
    // partial expiry INSIDE reserve, so the reservation must fail.
    await expect(
      reserveCredits(
        {
          applicationId: app.id,
          externalCustomerId: "user-1",
          creditType: "tokens",
          amount: 100,
          referenceType: "job",
          referenceId: "j-bypass",
          idempotencyKey: "r-bypass",
        },
        db,
      ),
    ).rejects.toThrow();

    const account = await accountOf(app.id, "tokens");
    // The in-reserve expiry cleaned the available side.
    expect(account?.availableBalance).toBe(0);
    expect(account?.reservedBalance).toBe(0);
    expect(await invariantHolds(app.id, "tokens")).toBe(true);
  });

  it("released-back credits on an expired bucket are refused by consumption and retired by the next sweep", async () => {
    const { app, customer } = await seed("exp-release");
    // Future expiry so the reservation predates it (round-2 semantics).
    const expiry = new Date(Date.now() + 2000);
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
        expiresAt: expiry,
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

    // Cross the expiry, then sweep: partial expiry takes the available 30.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await expireDueCreditBuckets(db, new Date());

    // Release the pre-expiry reservation: the 20 lands back on an
    // already-expired bucket (available restored, bucket overdue).
    await releaseReservation(
      {
        applicationId: app.id,
        reservationId: reservation.id,
        idempotencyKey: "rel2",
      },
      db,
    );
    // Consumption must refuse the released-back expired credits...
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
