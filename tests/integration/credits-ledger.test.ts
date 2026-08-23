import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import {
  creditReservations,
  creditTransactions,
} from "../../src/modules/credits/schema";
import {
  captureReservation,
  debitCredits,
  getCreditBalance,
  grantCredits,
  InsufficientCreditsError,
  refundCredits,
  releaseReservation,
  reserveCredits,
} from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";

const db = getDb();

async function createFixture(slugPrefix = "credits") {
  const suffix = Math.random().toString(36).slice(2, 8);
  const app = await createApplication(
    { slug: `${slugPrefix}-${suffix}`, name: "Credits" },
    db,
  );
  const applicationCustomer = await createApplicationCustomer(
    {
      applicationId: app.id,
      externalCustomerId: "user-1",
      email: `${suffix}@credits.test`,
    },
    db,
  );
  return { app, applicationCustomer };
}

async function seedCredits(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  amount: number,
  idempotencyKey = "seed",
) {
  return grantCredits(
    {
      applicationId: fixture.app.id,
      applicationCustomerId: fixture.applicationCustomer.id,
      creditType: "agent.run",
      amount,
      transactionType: "grant.promotion",
      sourceType: "test",
      sourceId: idempotencyKey,
      idempotencyKey,
    },
    db,
  );
}

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

describe("atomic credits ledger", () => {
  it("allows only the funded subset of 100 concurrent debits and never goes negative", async () => {
    const fixture = await createFixture("credits-concurrent");
    await seedCredits(fixture, 50);

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        debitCredits(
          {
            applicationId: fixture.app.id,
            externalCustomerId: "user-1",
            creditType: "agent.run",
            amount: 1,
            sourceType: "usage",
            sourceId: `job-${index}`,
            idempotencyKey: `debit-${index}`,
          },
          db,
        ),
      ),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(50);
    expect(rejected).toHaveLength(50);
    expect(
      rejected.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof InsufficientCreditsError,
      ),
    ).toBe(true);

    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 0, reserved: 0 });

    const transactions = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationId, fixture.app.id));
    expect(transactions).toHaveLength(51);
    expect(
      transactions.every((transaction) => transaction.availableAfter >= 0),
    ).toBe(true);
  });

  it("serializes repeated idempotency keys so a debit and reserve apply once", async () => {
    const fixture = await createFixture("credits-idempotency");
    await seedCredits(fixture, 20);

    const repeatedDebits = await Promise.all(
      Array.from({ length: 8 }, () =>
        debitCredits(
          {
            applicationId: fixture.app.id,
            externalCustomerId: "user-1",
            creditType: "agent.run",
            amount: 3,
            sourceType: "usage",
            sourceId: "job-same",
            idempotencyKey: "same-debit",
          },
          db,
        ),
      ),
    );
    expect(repeatedDebits.filter((result) => !result.duplicate)).toHaveLength(
      1,
    );
    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 17, reserved: 0 });

    const firstReserve = await reserveCredits(
      {
        applicationId: fixture.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 10,
        referenceType: "agent_job",
        referenceId: "job-reserve",
        idempotencyKey: "same-reserve",
      },
      db,
    );
    const secondReserve = await reserveCredits(
      {
        applicationId: fixture.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 10,
        referenceType: "agent_job",
        referenceId: "job-reserve",
        idempotencyKey: "same-reserve",
      },
      db,
    );

    expect(firstReserve.duplicate).toBe(false);
    expect(secondReserve.duplicate).toBe(true);
    expect(secondReserve.reservation.id).toBe(firstReserve.reservation.id);
    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 7, reserved: 10 });
  });

  it("keeps reserved credits unavailable, partially captures, and releases exactly once", async () => {
    const fixture = await createFixture("credits-reservation");
    await seedCredits(fixture, 100);

    const reserved = await reserveCredits(
      {
        applicationId: fixture.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 50,
        referenceType: "agent_job",
        referenceId: "job-50",
        idempotencyKey: "reserve-50",
      },
      db,
    );
    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 50, reserved: 50 });

    await expect(
      debitCredits(
        {
          applicationId: fixture.app.id,
          externalCustomerId: "user-1",
          creditType: "agent.run",
          amount: 60,
          sourceType: "usage",
          sourceId: "unrelated-job",
          idempotencyKey: "unrelated-debit",
        },
        db,
      ),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    const captured = await captureReservation(
      {
        applicationId: fixture.app.id,
        reservationId: reserved.reservation.id,
        amount: 32,
        idempotencyKey: "capture-32",
      },
      db,
    );
    expect(captured.duplicate).toBe(false);
    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 68, reserved: 0 });

    const captureReplay = await captureReservation(
      {
        applicationId: fixture.app.id,
        reservationId: reserved.reservation.id,
        amount: 32,
        idempotencyKey: "capture-32",
      },
      db,
    );
    expect(captureReplay.duplicate).toBe(true);
    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 68, reserved: 0 });

    const releasable = await reserveCredits(
      {
        applicationId: fixture.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 20,
        referenceType: "agent_job",
        referenceId: "job-release",
        idempotencyKey: "reserve-release",
      },
      db,
    );
    await releaseReservation(
      {
        applicationId: fixture.app.id,
        reservationId: releasable.reservation.id,
        idempotencyKey: "release-20",
      },
      db,
    );
    const releaseReplay = await releaseReservation(
      {
        applicationId: fixture.app.id,
        reservationId: releasable.reservation.id,
        idempotencyKey: "release-20",
      },
      db,
    );
    expect(releaseReplay.duplicate).toBe(true);
    expect(
      await getCreditBalance(fixture.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 68, reserved: 0 });
  });

  it("serializes capture/release races into one terminal reservation state", async () => {
    const fixture = await createFixture("credits-race");
    await seedCredits(fixture, 40);
    const reserved = await reserveCredits(
      {
        applicationId: fixture.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 30,
        referenceType: "agent_job",
        referenceId: "job-race",
        idempotencyKey: "reserve-race",
      },
      db,
    );

    const results = await Promise.allSettled([
      captureReservation(
        {
          applicationId: fixture.app.id,
          reservationId: reserved.reservation.id,
          amount: 15,
          idempotencyKey: "capture-race",
        },
        db,
      ),
      releaseReservation(
        {
          applicationId: fixture.app.id,
          reservationId: reserved.reservation.id,
          idempotencyKey: "release-race",
        },
        db,
      ),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const [reservation] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reserved.reservation.id))
      .limit(1);
    expect(["captured", "released"]).toContain(reservation?.status);

    const balance = await getCreditBalance(
      fixture.app.id,
      "user-1",
      "agent.run",
      db,
    );
    expect(balance.reserved).toBe(0);
    expect([25, 40]).toContain(balance.available);
  });

  it("isolates balances by application and restores debited usage through an auditable refund path", async () => {
    const first = await createFixture("credits-first");
    const second = await createFixture("credits-second");
    await seedCredits(first, 25);

    expect(
      await getCreditBalance(second.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 0, reserved: 0 });
    await expect(
      debitCredits(
        {
          applicationId: second.app.id,
          externalCustomerId: "user-1",
          creditType: "agent.run",
          amount: 1,
          sourceType: "usage",
          sourceId: "cross-app",
          idempotencyKey: "cross-app-debit",
        },
        db,
      ),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    await debitCredits(
      {
        applicationId: first.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 10,
        sourceType: "usage",
        sourceId: "job-refund",
        idempotencyKey: "debit-refund",
      },
      db,
    );
    await refundCredits(
      {
        applicationId: first.app.id,
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 10,
        sourceType: "usage_refund",
        sourceId: "job-refund",
        idempotencyKey: "refund-usage",
        metadata: { reason: "refund.usage" },
      },
      db,
    );

    expect(
      await getCreditBalance(first.app.id, "user-1", "agent.run", db),
    ).toEqual({ creditType: "agent.run", available: 25, reserved: 0 });
    const transactions = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationId, first.app.id));
    expect(
      transactions.some((transaction) => transaction.sourceId === "job-refund"),
    ).toBe(true);
    expect(
      transactions.some(
        (transaction) => transaction.metadata.reason === "refund.usage",
      ),
    ).toBe(true);
  });
});
