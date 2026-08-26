import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import {
  creditAccounts,
  creditTransactions,
} from "../../src/modules/credits/schema";
import {
  debitCredits,
  getCreditBalance,
  grantCredits,
} from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";

/**
 * P0 Gate #12 — Credit correctness: "Ledger insertion failure rolls back
 * balance changes."
 *
 * Strategy: wrap the real Drizzle Database in a Proxy that intercepts
 * `insert(creditTransactions)` inside a debit transaction and throws.
 * After the rejected debit, the balance must remain unchanged and no
 * transaction row may exist for that idempotency key.
 */

const realDb = getDb();

/**
 * Recursively wrap a Drizzle db/tx object so that `insert(creditTransactions)`
 * throws, simulating a ledger insertion failure (disk full, constraint
 * violation, serialization failure, etc.).
 *
 * The Proxy also wraps the object returned by `.transaction()` so that
 * the `tx` passed to the callback has the same interception.
 */
function wrapWithFailingLedgerInsert<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      // Intercept .transaction() to wrap the tx callback argument
      if (prop === "transaction") {
        const original = Reflect.get(t, prop, receiver) as (
          callback: (tx: T) => Promise<unknown>,
        ) => Promise<unknown>;
        return ((callback: (tx: T) => Promise<unknown>) => {
          return original((tx: T) => callback(wrapWithFailingLedgerInsert(tx)));
        }) as typeof original;
      }

      // Intercept .insert() to throw on creditTransactions
      if (prop === "insert") {
        const original = Reflect.get(t, prop, receiver) as (
          table: unknown,
        ) => unknown;
        return ((table: unknown) => {
          if (table === creditTransactions) {
            throw new Error("Simulated ledger insertion failure");
          }
          return original.call(t, table);
        }) as typeof original;
      }

      return Reflect.get(t, prop, receiver);
    },
  });
}

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

describe("credit ledger rollback on insertion failure", () => {
  it("rolls back balance changes when ledger insertion fails", async () => {
    const app = await createApplication(
      {
        slug: `credits-rollback-${Math.random().toString(36).slice(2, 8)}`,
        name: "Credits Rollback",
      },
      realDb,
    );
    const applicationCustomer = await createApplicationCustomer(
      {
        applicationId: app.id,
        externalCustomerId: "user-1",
        email: "rollback@test",
      },
      realDb,
    );

    // Seed initial credits (uses realDb, not the failing proxy)
    await grantCredits(
      {
        applicationId: app.id,
        applicationCustomerId: applicationCustomer.id,
        creditType: "agent.run",
        amount: 100,
        transactionType: "grant.promotion",
        sourceType: "test",
        sourceId: "seed",
        idempotencyKey: "seed-rollback",
      },
      realDb,
    );

    const balanceBefore = await getCreditBalance(
      app.id,
      "user-1",
      "agent.run",
      realDb,
    );
    expect(balanceBefore.available).toBe(100);

    // Attempt a debit with a failing ledger insert
    const failingDb = wrapWithFailingLedgerInsert(realDb);

    await expect(
      debitCredits(
        {
          applicationId: app.id,
          externalCustomerId: "user-1",
          creditType: "agent.run",
          amount: 30,
          sourceType: "usage",
          sourceId: "job-rollback",
          idempotencyKey: "debit-rollback",
        },
        failingDb,
      ),
    ).rejects.toThrow("Simulated ledger insertion failure");

    // Balance must remain unchanged — the debit was rolled back
    const balanceAfter = await getCreditBalance(
      app.id,
      "user-1",
      "agent.run",
      realDb,
    );
    expect(balanceAfter.available).toBe(100);
    expect(balanceAfter.reserved).toBe(0);

    // No transaction row should exist for the failed debit
    const transactions = await realDb
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationId, app.id));
    expect(
      transactions.filter((tx) => tx.idempotencyKey === "debit-rollback"),
    ).toHaveLength(0);

    // The account balance should still be 100 (only the seed grant)
    const [account] = await realDb
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.applicationId, app.id))
      .limit(1);
    expect(account?.availableBalance).toBe(100);
  });
});
