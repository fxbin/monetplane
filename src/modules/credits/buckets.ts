import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
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
 *   3. bucket id as the final tie-break (total order);
 *   4. never-expiring buckets (purchased credits by default) sort last
 *      because NULLS LAST pushes them behind every expiring bucket.
 *
 * Concurrency / lock order (B4): bucket rows are mutated under
 * `SELECT ... FOR UPDATE`, and every bucket writer acquires locks in the
 * same canonical order:
 *
 *   credit account row → bucket rows (in the consumption order above)
 *
 * Debits and captures establish the account lock first (their account
 * UPDATE precedes consumption); expiry locks the account row explicitly
 * before re-reading the bucket. A total ORDER BY (with the id tie-break)
 * guarantees overlapping consumers lock buckets in identical order, so
 * concurrent consumption serializes instead of deadlocking or
 * last-writer-winning.
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
  options: { allowExpired?: boolean } = {},
) {
  if (amount <= 0) return;
  let remaining = amount;
  // FOR UPDATE is required: without row locks two transactions consuming
  // overlapping bucket sets could both compute nextRemaining from the same
  // stale read and last-writer-win, corrupting the allocation. The ORDER BY
  // is a total order (expiresAt, createdAt, id) so all consumers acquire
  // row locks in the identical canonical sequence — no deadlocks. The
  // consumption loop below iterates rows in this exact order, so the lock
  // order IS the consumption order.
  const now = new Date();
  const rows = await db
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.creditAccountId, creditAccountId),
        eq(creditBuckets.status, "active"),
        // P0 defense (external review 2026-10-06): a bucket past its
        // expiry must never be consumable by NEW spending, even while the
        // expiry sweep defers it (open reservations) or hasn't reached it
        // yet. Capturing an EXISTING reservation predating the expiry is
        // settlement of a prior claim, not new spending — capture passes
        // allowExpired for exactly that case (grandfather semantics).
        ...(options.allowExpired
          ? []
          : [
              or(
                isNull(creditBuckets.expiresAt),
                gt(creditBuckets.expiresAt, now),
              ),
            ]),
      ),
    )
    .orderBy(
      sql`${creditBuckets.expiresAt} ASC NULLS LAST`,
      asc(creditBuckets.createdAt),
      asc(creditBuckets.id),
    )
    .for("update");

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
 * Account-scoped partial expiry (external review round-2 P0 fix):
 * expires the AVAILABLE-backed portion of the account's due buckets,
 * intended to run INSIDE a reserve/debit transaction right after the
 * account row is locked — so "new spending" always evaluates against a
 * clean available balance and cannot draw on expired credits through the
 * reserve → capture path (capture deliberately settles pre-expiry
 * reservations via allowExpired).
 *
 * PRECONDITION (round-3 fix): the caller MUST already hold the account
 * row lock (SELECT ... FOR UPDATE) before invoking this helper. The
 * account read below is deliberately lock-free — taking it here would
 * invert the canonical account → buckets lock order and deadlock against
 * concurrent debit/release paths.
 */
export async function expireDueBucketsForAccount(
  applicationId: string,
  accountId: string,
  environment: string,
  tx: Pick<Database, "select" | "insert" | "update">,
  now: Date = new Date(),
): Promise<void> {
  const due = await tx
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.creditAccountId, accountId),
        eq(creditBuckets.applicationId, applicationId),
        eq(creditBuckets.environment, environment),
        eq(creditBuckets.status, "active"),
        sql`${creditBuckets.expiresAt} IS NOT NULL`,
        lte(creditBuckets.expiresAt, now),
        sql`${creditBuckets.remainingAmount} > 0`,
      ),
    )
    .orderBy(
      sql`${creditBuckets.expiresAt} ASC NULLS LAST`,
      asc(creditBuckets.createdAt),
      asc(creditBuckets.id),
    )
    .for("update");

  for (const bucket of due) {
    // Lock-free read: the caller holds the account row lock (see
    // precondition above), so this balance is stable for the duration of
    // the transaction and re-locking here would deadlock.
    const [account] = await tx
      .select({
        availableBalance: creditAccounts.availableBalance,
      })
      .from(creditAccounts)
      .where(eq(creditAccounts.id, accountId));
    if (!account) return;
    const fresh = bucket; // rows were locked above in canonical order
    const reversible = Math.min(
      fresh.remainingAmount,
      account.availableBalance,
    );
    if (reversible <= 0) continue;

    await tx.insert(creditTransactions).values({
      id: `ctx_${randomUUID()}`,
      applicationId: fresh.applicationId,
      applicationCustomerId: fresh.applicationCustomerId,
      creditAccountId: fresh.creditAccountId,
      type: "grant.expired",
      amount: -reversible,
      availableAfter: 0, // recomputed below
      reservedAfter: 0,
      sourceType: "expiration",
      sourceId: fresh.id,
      environment: fresh.environment,
      idempotencyKey: `expire:${fresh.id}:before:${fresh.remainingAmount}`,
      metadata: { bucketId: fresh.id, expiredAt: now.toISOString() },
    });

    const [updatedAccount] = await tx
      .update(creditAccounts)
      .set({
        availableBalance: sql`greatest(${creditAccounts.availableBalance} - ${reversible}, 0)`,
        version: sql`${creditAccounts.version} + 1`,
        updatedAt: now,
      })
      .where(eq(creditAccounts.id, accountId))
      .returning();
    if (updatedAccount) {
      await tx
        .update(creditTransactions)
        .set({
          availableAfter: updatedAccount.availableBalance,
          reservedAfter: updatedAccount.reservedBalance,
        })
        .where(
          and(
            eq(creditTransactions.creditAccountId, accountId),
            eq(
              creditTransactions.idempotencyKey,
              `expire:${fresh.id}:before:${fresh.remainingAmount}`,
            ),
          ),
        );
    }

    const nextRemaining = fresh.remainingAmount - reversible;
    await tx
      .update(creditBuckets)
      .set({
        status: nextRemaining === 0 ? "expired" : "active",
        remainingAmount: nextRemaining,
        updatedAt: now,
      })
      .where(eq(creditBuckets.id, fresh.id));
  }
}

/**
 * Expire due buckets. Every expiry produces a traceable 'grant.expired'
 * reversal ledger entry and decrements the account balance — never a
 * silent mutation. Returns the expired buckets.
 */
export async function expireDueCreditBuckets(
  db: CreditStore & { transaction: Database["transaction"] } = getDb(),
  now: Date = new Date(),
) {
  // Deterministic scan order (same canonical order as consumption). The
  // per-bucket transactions below re-validate under lock, so an unlocked
  // outer read is safe — this ordering only makes concurrent expiry runs
  // process buckets in a stable, predictable sequence.
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
    )
    .orderBy(
      sql`${creditBuckets.expiresAt} ASC NULLS LAST`,
      asc(creditBuckets.createdAt),
      asc(creditBuckets.id),
    );
  const expired: Array<{ bucketId: string; reversedAmount: number }> = [];
  for (const bucket of due) {
    await db.transaction(async (tx) => {
      // Canonical lock order: account row FIRST, then bucket rows. Debits
      // and captures hold the account row lock (their UPDATE precedes
      // consumeBuckets) before locking buckets; expiry must do the same or
      // a concurrent debit and expiry could deadlock (bucket→account vs
      // account→bucket). After acquiring the account lock, any competing
      // debit has committed and the bucket re-read below sees its effect.
      const [lockedAccount] = await tx
        .select({
          id: creditAccounts.id,
          availableBalance: creditAccounts.availableBalance,
        })
        .from(creditAccounts)
        .where(eq(creditAccounts.id, bucket.creditAccountId))
        .for("update");
      // Partial expiry (external review 2026-10-06, P0 fix): expire the
      // AVAILABLE portion now, leave only the reserved-backed residual.
      // A bucket's remaining backs both available and reserved; expiring
      // more than available would break the invariant, but skipping the
      // whole account (the earlier approach) let one never-settling
      // reservation keep an entire expired cycle spendable. The residual
      // settles through the normal reservation lifecycle: capture consumes
      // it, release lands it back on an already-expired bucket where the
      // consumption guard (consumeBuckets) refuses it and the next sweep
      // retires it.
      if (!lockedAccount) {
        return;
      }
      const [fresh] = await tx
        .select()
        .from(creditBuckets)
        .where(eq(creditBuckets.id, bucket.id))
        .limit(1)
        .for("update");
      if (!fresh || fresh.status !== "active" || fresh.remainingAmount <= 0) {
        return;
      }
      const reversible = Math.min(
        fresh.remainingAmount,
        lockedAccount.availableBalance,
      );
      if (reversible <= 0) {
        // Everything this bucket backs is currently reserved; nothing can
        // be expired right now. The reservations will settle through
        // capture/release and a later sweep retires the residual.
        return;
      }

      // Reversal ledger entry (negative amount) keeps the audit trail.
      // The reversal amount is the available-backed portion only; the
      // reserved-backed residual retires in a later sweep after the
      // reservations settle (monotonic remainingBefore-keyed entries make
      // multi-stage expiry replay-safe).
      const [reversal] = await tx
        .insert(creditTransactions)
        .values({
          id: `ctx_${randomUUID()}`,
          applicationId: fresh.applicationId,
          applicationCustomerId: fresh.applicationCustomerId,
          creditAccountId: fresh.creditAccountId,
          type: "grant.expired",
          amount: -reversible,
          availableAfter: 0, // recomputed below
          reservedAfter: 0,
          sourceType: "expiration",
          sourceId: fresh.id,
          environment: fresh.environment,
          // Monotonic state key: a bucket can expire in stages (partial
          // now, residual after reservation settlement), so the idempotency
          // key must distinguish stages by the remaining BEFORE this stage.
          idempotencyKey: `expire:${fresh.id}:before:${fresh.remainingAmount}`,
          metadata: { bucketId: fresh.id, expiredAt: now.toISOString() },
        })
        .returning();

      const [account] = await tx
        .update(creditAccounts)
        .set({
          availableBalance: sql`greatest(${creditAccounts.availableBalance} - ${reversible}, 0)`,
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

      const nextRemaining = fresh.remainingAmount - reversible;
      await tx
        .update(creditBuckets)
        .set({
          // Fully drained buckets retire; partial ones stay active with the
          // reserved-backed residual (consumption guard refuses expired
          // buckets regardless of status).
          status: nextRemaining === 0 ? "expired" : "active",
          remainingAmount: nextRemaining,
          updatedAt: now,
        })
        .where(eq(creditBuckets.id, fresh.id));

      expired.push({
        bucketId: fresh.id,
        reversedAmount: reversible,
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
