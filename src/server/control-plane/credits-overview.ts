import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  creditAccounts,
  creditBuckets,
  creditReservations,
  creditTransactions,
} from "@/modules/credits/schema";
import { applicationCustomers } from "@/modules/customers/schema";

/**
 * Read-side aggregation for the /credits overview page (roundtable
 * 2026-10-06, PR3). All queries are ledger-derived group-bys — no new
 * tables, no registry; the type list is whatever the accounts actually
 * contain (the roundtable's "无目录方案").
 */

export type CreditTypeSummary = {
  creditType: string;
  customers: number;
  /** bigint sums arrive as strings from node-postgres; parsed to Number. */
  available: number;
  reserved: number;
};

export type CreditLedgerEntry = {
  id: string;
  creditType: string;
  amount: number;
  type: string;
  sourceType: string;
  customer: string | null;
  createdAt: Date;
};

export type ExpiringBucket = {
  id: string;
  creditType: string;
  remaining: number;
  expiresAt: Date;
  customer: string | null;
};

export type ActiveReservation = {
  id: string;
  creditType: string;
  reservedAmount: number;
  referenceType: string;
  referenceId: string;
  createdAt: Date;
  customer: string | null;
};

export async function getCreditsOverview(
  applicationId: string,
  environment: "test" | "live",
) {
  const db = getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const soon = new Date(Date.now() + 30 * 24 * 3600 * 1000);

  const [typeSummaries, recentLedger, expiringBuckets, activeReservations] =
    await Promise.all([
      db
        .select({
          creditType: creditAccounts.creditType,
          customers: sql<number>`count(*)::int`,
          available: sql<string>`coalesce(sum(${creditAccounts.availableBalance}), 0)::bigint`,
          reserved: sql<string>`coalesce(sum(${creditAccounts.reservedBalance}), 0)::bigint`,
        })
        .from(creditAccounts)
        .where(
          and(
            eq(creditAccounts.applicationId, applicationId),
            eq(creditAccounts.environment, environment),
          ),
        )
        .groupBy(creditAccounts.creditType)
        .orderBy(
          desc(sql`coalesce(sum(${creditAccounts.availableBalance}), 0)`),
        ),

      db
        .select({
          id: creditTransactions.id,
          creditType: creditAccounts.creditType,
          amount: creditTransactions.amount,
          type: creditTransactions.type,
          sourceType: creditTransactions.sourceType,
          customer: applicationCustomers.externalCustomerId,
          createdAt: creditTransactions.createdAt,
        })
        .from(creditTransactions)
        .innerJoin(
          creditAccounts,
          eq(creditTransactions.creditAccountId, creditAccounts.id),
        )
        .leftJoin(
          applicationCustomers,
          eq(creditAccounts.applicationCustomerId, applicationCustomers.id),
        )
        .where(
          and(
            eq(creditTransactions.applicationId, applicationId),
            eq(creditTransactions.environment, environment),
            gte(creditTransactions.createdAt, sevenDaysAgo),
          ),
        )
        .orderBy(desc(creditTransactions.createdAt))
        .limit(30),

      db
        .select({
          id: creditBuckets.id,
          creditType: creditAccounts.creditType,
          remaining: creditBuckets.remainingAmount,
          expiresAt: creditBuckets.expiresAt,
          customer: applicationCustomers.externalCustomerId,
        })
        .from(creditBuckets)
        .innerJoin(
          creditAccounts,
          eq(creditBuckets.creditAccountId, creditAccounts.id),
        )
        .leftJoin(
          applicationCustomers,
          eq(creditAccounts.applicationCustomerId, applicationCustomers.id),
        )
        .where(
          and(
            eq(creditBuckets.applicationId, applicationId),
            eq(creditBuckets.environment, environment),
            isNotNull(creditBuckets.expiresAt),
            lte(creditBuckets.expiresAt, soon),
            sql`${creditBuckets.remainingAmount} > 0`,
          ),
        )
        .orderBy(creditBuckets.expiresAt)
        .limit(20),

      db
        .select({
          id: creditReservations.id,
          creditType: creditAccounts.creditType,
          reservedAmount: creditReservations.reservedAmount,
          referenceType: creditReservations.referenceType,
          referenceId: creditReservations.referenceId,
          createdAt: creditReservations.createdAt,
          customer: applicationCustomers.externalCustomerId,
        })
        .from(creditReservations)
        .innerJoin(
          creditAccounts,
          eq(creditReservations.creditAccountId, creditAccounts.id),
        )
        .leftJoin(
          applicationCustomers,
          eq(creditReservations.applicationCustomerId, applicationCustomers.id),
        )
        .where(
          and(
            eq(creditReservations.applicationId, applicationId),
            eq(creditReservations.environment, environment),
            eq(creditReservations.status, "active"),
          ),
        )
        .orderBy(desc(creditReservations.createdAt))
        .limit(20),
    ]);

  return {
    // bigint sums come back as strings; credits are safe integers by
    // construction, so Number() is lossless here.
    typeSummaries: typeSummaries.map((row) => ({
      ...row,
      available: Number(row.available),
      reserved: Number(row.reserved),
    })),
    recentLedger,
    expiringBuckets,
    activeReservations,
  };
}
