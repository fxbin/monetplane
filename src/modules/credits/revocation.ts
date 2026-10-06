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
 * NOTE: operates on the caller's client — production callers invoke this
 * INSIDE their transaction (the webhook's cancel branch) so the clawback
 * is atomic with the subscription state change. Standalone (test) callers
 * get no wrapping transaction.
 */
export async function revokeSubscriptionCredits(
  input: {
    applicationId: string;
    subscriptionId: string;
    environment?: "test" | "live";
    reason?: "subscription_cancelled" | "subscription_expired";
  },
  db: CreditRevocationStore = getDb(),
): Promise<Array<{ creditType: string; revokedAmount: number }>> {
  const environment = input.environment ?? "test";

  // Accounts holding buckets sourced from this subscription.
  const buckets = await db
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
    )
    .for("update");

  if (buckets.length === 0) return [];

  // Canonical lock order: account row first (same as expiry/consumption).
  const accountIds = [...new Set(buckets.map((b) => b.creditAccountId))];
  const accountRows = await db
    .select()
    .from(creditAccounts)
    .where(inArray(creditAccounts.id, accountIds))
    .for("update");
  const availableByAccount = new Map(
    accountRows.map((row) => [row.id, row.availableBalance]),
  );

  const revokedByType = new Map<string, number>();
  const takenByAccount = new Map<string, number>();

  for (const bucket of buckets) {
    const alreadyTaken = takenByAccount.get(bucket.creditAccountId) ?? 0;
    const allowance =
      (availableByAccount.get(bucket.creditAccountId) ?? 0) - alreadyTaken;
    if (allowance <= 0) continue;

    const take = Math.min(bucket.remaining, allowance);
    if (take <= 0) continue;

    await db
      .update(creditBuckets)
      .set({
        remainingAmount: sql`${creditBuckets.remainingAmount} - ${take}`,
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
      idempotencyKey: `revoke:${input.subscriptionId}:${bucket.id}`,
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
