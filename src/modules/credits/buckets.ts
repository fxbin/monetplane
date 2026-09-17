import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  creditAccounts,
  creditBuckets,
  creditTransactions,
} from "@/modules/credits/schema";

/**
 * Credit grant buckets (#63).
 *
 * Every grant creates one auditable bucket (source, granted/remaining
 * amount, validity window). Balance mutations flow exclusively through
 * the ledger; buckets track the allocation behind those ledger effects:
 *
 *   sum(active bucket remaining) == availableBalance + reservedBalance
 *
 * Consumption ordering (deterministic, documented):
 *   1. soonest-expiring buckets first (protect nothing from expiry);
 *   2. tie-break by creation time (oldest grant first);
 *   3. never-expiring buckets (purchased credits by default) last.
 *
 * Subscription-period allowances are granted with an explicit expiresAt;
 * rollover is explicit: a new period grants a NEW bucket, and any leftover
 * old bucket expires through a 'grant.expired' reversal ledger entry.
 */

export type CreditStore = Pick<
  Database,
  "select" | "insert" | "update" | "execute"
>;

export type BucketSourceType =
  | "purchase"
  | "subscription"
  | "promotion"
  | "admin"
  | "refund";

export function bucketSourceForTransactionType(
  transactionType: string,
): BucketSourceType {
  switch (transactionType) {
    case "grant.purchase":
      return "purchase";
    case "grant.subscription":
      return "subscription";
    case "grant.promotion":
      return "promotion";
    case "refund.usage":
      return "refund";
    default:
      return "admin";
  }
}

export async function createBucketForGrant(
  input: {
    applicationId: string;
    environment: "test" | "live";
    applicationCustomerId: string;
    creditAccountId: string;
    creditType: string;
    sourceType: BucketSourceType;
    sourceId: string;
    transactionId: string;
    amount: number;
    expiresAt?: Date | null;
  },
  db: CreditStore,
) {
  const [bucket] = await db
    .insert(creditBuckets)
    .values({
      id: `bucket_${randomUUID()}`,
      applicationId: input.applicationId,
      environment: input.environment,
      applicationCustomerId: input.applicationCustomerId,
      creditAccountId: input.creditAccountId,
      creditType: input.creditType,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      transactionId: input.transactionId,
      grantedAmount: input.amount,
      remainingAmount: input.amount,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!bucket) throw new Error("Failed to create credit bucket");
  return bucket;
}

/** Consume `amount` from the account's active buckets, soonest-expiry first. */
export async function consumeBuckets(
  creditAccountId: string,
  amount: number,
  db: CreditStore,
) {
  if (amount <= 0) return;
  let remaining = amount;
  const rows = await db
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.creditAccountId, creditAccountId),
        eq(creditBuckets.status, "active"),
      ),
    )
    .orderBy(
      sql`${creditBuckets.expiresAt} ASC NULLS LAST`,
      asc(creditBuckets.createdAt),
    );

  for (const bucket of rows) {
    if (remaining <= 0) break;
    const take = Math.min(bucket.remainingAmount, remaining);
    remaining -= take;
    const nextRemaining = bucket.remainingAmount - take;
    await db
      .update(creditBuckets)
      .set({
        remainingAmount: nextRemaining,
        status: nextRemaining === 0 ? "consumed" : "active",
        updatedAt: new Date(),
      })
      .where(eq(creditBuckets.id, bucket.id));
  }
  if (remaining > 0) {
    throw new Error(
      "Bucket allocation invariant violated: consumption exceeds active buckets",
    );
  }
}

/**
 * Expire due buckets. Every expiry produces a traceable 'grant.expired'
 * reversal ledger entry and decrements the account balance — never a
 * silent mutation. Returns the expired buckets.
 */
export async function expireDueCreditBuckets(
  db: CreditStore & { transaction: Database["transaction"] },
  now: Date = new Date(),
) {
  const due = await db
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.status, "active"),
        sql`${creditBuckets.expiresAt} IS NOT NULL`,
        lte(creditBuckets.expiresAt, now),
        sql`${creditBuckets.remainingAmount} > 0`,
      ),
    );

  const expired: Array<{ bucketId: string; reversedAmount: number }> = [];
  for (const bucket of due) {
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(creditBuckets)
        .where(eq(creditBuckets.id, bucket.id))
        .limit(1)
        .for("update");
      if (!fresh || fresh.status !== "active" || fresh.remainingAmount <= 0) {
        return;
      }

      // Reversal ledger entry (negative amount) keeps the audit trail.
      const [reversal] = await tx
        .insert(creditTransactions)
        .values({
          id: `ctx_${randomUUID()}`,
          applicationId: fresh.applicationId,
          applicationCustomerId: fresh.applicationCustomerId,
          creditAccountId: fresh.creditAccountId,
          type: "grant.expired",
          amount: -fresh.remainingAmount,
          availableAfter: 0, // recomputed below
          reservedAfter: 0,
          sourceType: "expiration",
          sourceId: fresh.id,
          environment: fresh.environment,
          idempotencyKey: `expire:${fresh.id}`,
          metadata: { bucketId: fresh.id, expiredAt: now.toISOString() },
        })
        .returning();

      const [account] = await tx
        .update(creditAccounts)
        .set({
          availableBalance: sql`greatest(${creditAccounts.availableBalance} - ${fresh.remainingAmount}, 0)`,
          version: sql`${creditAccounts.version} + 1`,
          updatedAt: now,
        })
        .where(eq(creditAccounts.id, fresh.creditAccountId))
        .returning();

      if (reversal && account) {
        await tx
          .update(creditTransactions)
          .set({
            availableAfter: account.availableBalance,
            reservedAfter: account.reservedBalance,
          })
          .where(eq(creditTransactions.id, reversal.id));
      }

      await tx
        .update(creditBuckets)
        .set({ status: "expired", remainingAmount: 0, updatedAt: now })
        .where(eq(creditBuckets.id, fresh.id));

      expired.push({
        bucketId: fresh.id,
        reversedAmount: fresh.remainingAmount,
      });
    });
  }
  return expired;
}

/** Console summary: where credits came from and what expires next. */
export async function getBucketSummary(
  applicationId: string,
  applicationCustomerId: string,
  environment: "test" | "live",
  db: CreditStore,
) {
  const buckets = await db
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.applicationId, applicationId),
        eq(creditBuckets.applicationCustomerId, applicationCustomerId),
        eq(creditBuckets.environment, environment),
        or(eq(creditBuckets.status, "active"), isNull(creditBuckets.expiresAt)),
      ),
    )
    .orderBy(asc(creditBuckets.expiresAt), asc(creditBuckets.createdAt));

  const active = buckets.filter((bucket) => bucket.status === "active");
  const expiringSoon = active
    .filter((bucket) => bucket.expiresAt !== null)
    .slice(0, 5);
  return {
    activeBuckets: active.map((bucket) => ({
      id: bucket.id,
      sourceType: bucket.sourceType,
      remainingAmount: bucket.remainingAmount,
      grantedAmount: bucket.grantedAmount,
      expiresAt: bucket.expiresAt,
    })),
    nextExpiries: expiringSoon.map((bucket) => ({
      id: bucket.id,
      remainingAmount: bucket.remainingAmount,
      expiresAt: bucket.expiresAt,
    })),
  };
}
