import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { creditAccounts, creditBuckets, creditTransactions } from "./schema";

/**
 * Subscription credit clawback (roundtable 2026-10-06, PR-C).
 *
 * When a subscription terminates (cancelled webhook or journaled cancel),
 * the unused credits its cycles granted are contract liabilities that no
 * longer have a backing contract — MonetPlane revokes them with a
 * `grant.revoked` ledger entry, kept STRICTLY SEPARATE from
 * `grant.expired` (time-triggered) per the accounting decision: mixing
 * the two trigger kinds destroys the monthly reconciliation story.
 *
 * Revocation runs against the account's CURRENT available balance: an
 * allowance = availableBalance bounds what can be taken, so the bucket
 * invariant sum(active bucket remaining) == available + reserved is
 * preserved on both sides even when a reservation is open (the reserved
 * portion keeps its backing; it settles through the normal reservation
 * lifecycle). Buckets are drained soonest-expiring-first, matching the
 * consumption order.
 */
type CreditRevocationStore = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update"
>;

/**
 * Transaction-scoped core. Production callers (webhook cancel branch,
 * journal cancel reconcile) pass their tx so the clawback is atomic with
 * the subscription state change. The exported wrapper below adds a
 * transaction for standalone callers — there is deliberately NO
 * non-transactional entry point for a ledger-writing function.
 */
export async function revokeSubscriptionCreditsInTransaction(
  input: {
    applicationId: string;
    subscriptionId: string;
    environment?: "test" | "live";
    reason?: "subscription_cancelled" | "subscription_expired";
  },
  db: CreditRevocationStore,
): Promise<Array<{ creditType: string; revokedAmount: number }>> {
  const environment = input.environment ?? "test";

  // Phase 1 — unlocked discovery: find candidate bucket ids (and their
  // accounts). No row locks here; everything is re-validated under the
  // account lock in phase 2.
  const discovered = await db
    .select({
      id: creditBuckets.id,
      creditAccountId: creditBuckets.creditAccountId,
    })
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.applicationId, input.applicationId),
        eq(creditBuckets.environment, environment),
        eq(creditBuckets.status, "active"),
        sql`${creditBuckets.remainingAmount} > 0`,
        eq(creditBuckets.sourceType, "subscription"),
        eq(creditBuckets.sourceId, input.subscriptionId),
      ),
    )
    .orderBy(
      sql`${creditBuckets.expiresAt} ASC NULLS LAST`,
      creditBuckets.createdAt,
      creditBuckets.id,
    );

  if (discovered.length === 0) return [];

  // Phase 2 — canonical lock order (external review 2026-10-06): lock
  // ACCOUNT rows first in a deterministic (sorted) order, then re-lock the
  // buckets under the account lock. The previous shape locked buckets
  // (JOIN ... FOR UPDATE) before accounts, inverting the protocol shared
  // by debit/expiry/capture and risking deadlocks.
  const accountIds = [
    ...new Set(discovered.map((b) => b.creditAccountId)),
  ].sort();
  // orderBy makes the lock acquisition order deterministic at the SQL
  // level (external review round-2 P2): IN-list ordering alone does not
  // constrain PostgreSQL's row-lock order.
  const accountRows = await db
    .select()
    .from(creditAccounts)
    .where(inArray(creditAccounts.id, accountIds))
    .orderBy(creditAccounts.id)
    .for("update");
  const availableByAccount = new Map(
    accountRows.map((row) => [row.id, row.availableBalance]),
  );

  const locked = await db
    .select({
      id: creditBuckets.id,
      creditAccountId: creditBuckets.creditAccountId,
      remaining: creditBuckets.remainingAmount,
      creditType: creditAccounts.creditType,
      applicationCustomerId: creditAccounts.applicationCustomerId,
    })
    .from(creditBuckets)
    .innerJoin(
      creditAccounts,
      eq(creditBuckets.creditAccountId, creditAccounts.id),
    )
    .where(
      and(
        inArray(
          creditBuckets.id,
          discovered.map((b) => b.id),
        ),
        eq(creditBuckets.status, "active"),
        sql`${creditBuckets.remainingAmount} > 0`,
      ),
    )
    .orderBy(
      sql`${creditBuckets.expiresAt} ASC NULLS LAST`,
      creditBuckets.createdAt,
      creditBuckets.id,
    )
    .for("update");

  const revokedByType = new Map<string, number>();
  const takenByAccount = new Map<string, number>();

  for (const bucket of locked) {
    const alreadyTaken = takenByAccount.get(bucket.creditAccountId) ?? 0;
    const allowance =
      (availableByAccount.get(bucket.creditAccountId) ?? 0) - alreadyTaken;
    if (allowance <= 0) continue;

    // Monotonic state key (external review): the idempotency key embeds
    // the remaining BEFORE this stage. A reservation-bounded partial
    // clawback that later extends (after the reservation settles) gets a
    // distinct key; the same pre-state can never legitimately repeat, so
    // replays are deduped while extensions append.
    const take = Math.min(bucket.remaining, allowance);
    if (take <= 0) continue;
    const remainingBefore = bucket.remaining;

    await db
      .update(creditBuckets)
      .set({
        remainingAmount: sql`${creditBuckets.remainingAmount} - ${take}`,
        // Fully drained buckets retire (the schema's reserved `reversed`
        // status finally earns its keep); partial ones stay active with
        // the reserved-backed residual.
        status: take === bucket.remaining ? "reversed" : "active",
        updatedAt: new Date(),
      })
      .where(eq(creditBuckets.id, bucket.id));

    await db
      .update(creditAccounts)
      .set({
        availableBalance: sql`${creditAccounts.availableBalance} - ${take}`,
        version: sql`${creditAccounts.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(creditAccounts.id, bucket.creditAccountId));

    const [account] = await db
      .select({
        availableBalance: creditAccounts.availableBalance,
        reservedBalance: creditAccounts.reservedBalance,
      })
      .from(creditAccounts)
      .where(eq(creditAccounts.id, bucket.creditAccountId))
      .limit(1);

    await db.insert(creditTransactions).values({
      id: `ctx_${randomUUID()}`,
      applicationId: input.applicationId,
      applicationCustomerId: bucket.applicationCustomerId,
      creditAccountId: bucket.creditAccountId,
      type: "grant.revoked",
      amount: -take,
      availableAfter: account?.availableBalance ?? 0,
      reservedAfter: account?.reservedBalance ?? 0,
      sourceType: "subscription",
      sourceId: input.subscriptionId,
      environment,
      idempotencyKey: `revoke:${input.subscriptionId}:${bucket.id}:before:${remainingBefore}`,
      metadata: {
        bucketId: bucket.id,
        reason: input.reason ?? "subscription_cancelled",
      },
    });

    takenByAccount.set(bucket.creditAccountId, alreadyTaken + take);
    revokedByType.set(
      bucket.creditType,
      (revokedByType.get(bucket.creditType) ?? 0) + take,
    );
  }

  return [...revokedByType].map(([creditType, revokedAmount]) => ({
    creditType,
    revokedAmount,
  }));
}

/**
 * Standalone entry point: wraps the transaction-scoped core so casual
 * (test/diagnostic) callers cannot produce half-applied ledger writes.
 */
export async function revokeSubscriptionCredits(
  input: {
    applicationId: string;
    subscriptionId: string;
    environment?: "test" | "live";
    reason?: "subscription_cancelled" | "subscription_expired";
  },
  db: ReturnType<typeof getDb> = getDb(),
): Promise<Array<{ creditType: string; revokedAmount: number }>> {
  return db.transaction((tx) =>
    revokeSubscriptionCreditsInTransaction(
      input,
      tx as unknown as CreditRevocationStore,
    ),
  );
}
