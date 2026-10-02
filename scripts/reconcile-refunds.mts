/**
 * Refund reconciliation report (audit MP-REV-07 / issue #128).
 *
 * Report-only companion to the webhook ingest signals: the ingest caps new
 * refund facts at headroom and books provider-confirmed upgrades uncapped,
 * logging anomalies — this script surfaces the resulting DB states plus the
 * journal-pending ↔ webhook cross cases so operations can reconcile against
 * the provider's settlement records. It NEVER writes.
 *
 * Sections:
 *   [1] over-refunded payments   — sum(refunds pending+succeeded) > captured
 *   [2] stuck pending refunds    — pending older than --pending-hours (default 24h)
 *   [3] torn refunds             — payment refunded but order not refunded,
 *                                  or order entitlements still active
 *   [4] failed refund events     — inbox rows failed with refund/currency
 *                                  errors (permanent rejections, need review)
 *   [5] superseded journal facts — informational count (synthetic ids replaced)
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env scripts/reconcile-refunds.mts
 *   node --experimental-strip-types --env-file=.env scripts/reconcile-refunds.mts --json out.json --pending-hours 12
 *
 * Exit code is always 0 (a report is not a failure); the summary counts
 * tell you whether anything needs attention.
 */
import { writeFile } from "node:fs/promises";

import postgres from "postgres";

type OverRefundedRow = {
  paymentId: string;
  applicationId: string;
  providerPaymentId: string;
  capturedAmountMinor: string | number;
  refundTotalMinor: string | number;
  status: string;
};

type StuckPendingRow = {
  refundId: string;
  applicationId: string;
  providerRefundId: string;
  amountMinor: string | number | null;
  createdAt: string;
  hoursPending: string | number;
};

type TornRefundRow = {
  paymentId: string;
  applicationId: string;
  providerPaymentId: string;
  paymentStatus: string;
  orderStatus: string | null;
  activeEntitlements: string | number;
};

type FailedEventRow = {
  eventId: string;
  applicationId: string;
  providerEventId: string;
  errorMessage: string | null;
  createdAt: string;
};

function parseArgs(argv: string[]): {
  jsonPath?: string;
  pendingHours: number;
} {
  const jsonIndex = argv.indexOf("--json");
  const hoursIndex = argv.indexOf("--pending-hours");
  return {
    jsonPath: jsonIndex !== -1 ? argv[jsonIndex + 1] : undefined,
    pendingHours: hoursIndex !== -1 ? Number(argv[hoursIndex + 1]) : 24,
  };
}

function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  if (!value.startsWith("postgres://") && !value.startsWith("postgresql://")) {
    console.error("DATABASE_URL must be a PostgreSQL connection string");
    process.exit(2);
  }
  return value;
}

async function main() {
  const { jsonPath, pendingHours } = parseArgs(process.argv);
  const sql = postgres(getDatabaseUrl(), { max: 1 });

  try {
    const overRefunded = (await sql`
      SELECT p.id AS "paymentId",
             p.application_id AS "applicationId",
             p.provider_payment_id AS "providerPaymentId",
             p.amount_minor AS "capturedAmountMinor",
             COALESCE(SUM(r.amount_minor) FILTER (
               WHERE r.status IN ('pending', 'succeeded')
             ), 0) AS "refundTotalMinor",
             p.status
      FROM payments p
      JOIN refunds r ON r.payment_id = p.id
      GROUP BY p.id
      HAVING COALESCE(SUM(r.amount_minor) FILTER (
                WHERE r.status IN ('pending', 'succeeded')
              ), 0) > p.amount_minor
      ORDER BY p.created_at
    `) as unknown as OverRefundedRow[];

    const stuckPending = (await sql`
      SELECT r.id AS "refundId",
             r.application_id AS "applicationId",
             r.provider_refund_id AS "providerRefundId",
             r.amount_minor AS "amountMinor",
             r.created_at AS "createdAt",
             EXTRACT(EPOCH FROM (now() - r.created_at)) / 3600 AS "hoursPending"
      FROM refunds r
      WHERE r.status = 'pending'
        AND r.created_at < now() - (${pendingHours} * interval '1 hour')
      ORDER BY r.created_at
    `) as unknown as StuckPendingRow[];

    const tornRefunds = (await sql`
      SELECT p.id AS "paymentId",
             p.application_id AS "applicationId",
             p.provider_payment_id AS "providerPaymentId",
             p.status AS "paymentStatus",
             o.status AS "orderStatus",
             (
               SELECT count(*)
               FROM entitlement_grants eg
               WHERE eg.source_type = 'order'
                 AND eg.source_id = o.id
                 AND eg.status = 'active'
             ) AS "activeEntitlements"
      FROM payments p
      LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'refunded'
        AND (
          o.id IS NULL
          OR o.status <> 'refunded'
          OR EXISTS (
            SELECT 1 FROM entitlement_grants eg
            WHERE eg.source_type = 'order'
              AND eg.source_id = o.id
              AND eg.status = 'active'
          )
        )
      ORDER BY p.updated_at
    `) as unknown as TornRefundRow[];

    const failedEvents = (await sql`
      SELECT e.id AS "eventId",
             e.application_id AS "applicationId",
             e.provider_event_id AS "providerEventId",
             e.error_message AS "errorMessage",
             e.received_at AS "createdAt"
      FROM webhook_events e
      WHERE e.status = 'failed'
        AND (
          e.error_message ILIKE '%refund%'
          OR e.error_message ILIKE '%currency mismatch%'
        )
      ORDER BY e.received_at DESC
      LIMIT 200
    `) as unknown as FailedEventRow[];

    const [superseded] = (await sql`
      SELECT count(*)::int AS count FROM refunds WHERE status = 'superseded'
    `) as unknown as Array<{ count: number }>;

    console.log("=== Refund reconciliation report (read-only) ===");
    console.log("");
    console.log(`[1] over-refunded payments: ${overRefunded.length}`);
    for (const row of overRefunded) {
      console.log(
        `    payment ${row.paymentId} (${row.providerPaymentId}) captured ${row.capturedAmountMinor}, refunds ${row.refundTotalMinor}, status ${row.status}`,
      );
    }
    console.log("");
    console.log(
      `[2] refunds pending > ${pendingHours}h: ${stuckPending.length}`,
    );
    for (const row of stuckPending) {
      console.log(
        `    refund ${row.providerRefundId} amount ${row.amountMinor ?? "null"} pending ${Number(row.hoursPending).toFixed(1)}h since ${new Date(row.createdAt).toISOString()}`,
      );
    }
    console.log("");
    console.log(`[3] torn refund states: ${tornRefunds.length}`);
    for (const row of tornRefunds) {
      console.log(
        `    payment ${row.paymentId} (${row.providerPaymentId}) status ${row.paymentStatus}, order ${row.orderStatus ?? "unlinked"}, active entitlements ${row.activeEntitlements}`,
      );
    }
    console.log("");
    console.log(`[4] failed refund events (last 200): ${failedEvents.length}`);
    for (const row of failedEvents) {
      console.log(
        `    event ${row.providerEventId}: ${(row.errorMessage ?? "").slice(0, 120)}`,
      );
    }
    console.log("");
    console.log(`[5] superseded journal refund facts: ${superseded.count}`);
    console.log("");
    const needsAttention =
      overRefunded.length + stuckPending.length + tornRefunds.length;
    if (needsAttention === 0 && failedEvents.length === 0) {
      console.log("Result: nothing requires reconciliation.");
    } else {
      console.log(
        "Result: compare flagged rows against the provider settlement records before correcting. This script does not write.",
      );
    }

    if (jsonPath) {
      const payload = {
        generatedAt: new Date().toISOString(),
        pendingHours,
        overRefunded,
        stuckPending,
        tornRefunds,
        failedEvents,
        supersededCount: superseded.count,
      };
      await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
      console.log(`JSON report written to ${jsonPath}`);
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((error) => {
  console.error("refund reconciliation report failed:", error);
  process.exit(1);
});
