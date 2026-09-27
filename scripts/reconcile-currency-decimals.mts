/**
 * Currency-decimals reconciliation report (audit A1 follow-up).
 *
 * PR `eddf97c` unified the zero-decimal currency registry. Before that,
 * three historical divergences could store amounts at the wrong magnitude:
 *
 *   1. PayPal adapter treated ISK as 2-decimal  -> ISK amounts potentially 100x
 *   2. Waffo adapter treated MGA/XAF as 2-decimal -> amounts potentially 100x
 *   3. ProductBuilderWizard hardcoded x100 for every currency -> prices in ANY
 *      zero-decimal currency entered via the wizard are potentially 100x
 *
 * This script is REPORT-ONLY by design: money rows must be reconciled against
 * the provider's own settlement records before any correction. It never
 * writes. Run it, export the JSON, and compare each flagged row against the
 * provider dashboard.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env scripts/reconcile-currency-decimals.ts
 *   node --experimental-strip-types --env-file=.env scripts/reconcile-currency-decimals.ts --json out.json
 *
 * Exit code 0 always (a report is not a failure); the summary counts tell
 * you whether anything needs review.
 */
import { writeFile } from "node:fs/promises";
import postgres from "postgres";

type FlaggedMoneyRow = {
  source: "payments" | "refunds" | "orders";
  id: string;
  applicationId: string;
  provider: string;
  mode: string;
  currency: string;
  amountMinor: number | null;
  status: string;
  createdAt: string;
  reason: string;
};

type FlaggedPriceRow = {
  source: "catalog.prices";
  id: string;
  applicationId: string;
  productName: string;
  currency: string;
  amountMinor: number;
  createdAt: string;
  suspect: boolean;
  reason: string;
};

function parseArgs(argv: string[]): { jsonPath?: string } {
  const jsonIndex = argv.indexOf("--json");
  if (jsonIndex !== -1) {
    const jsonPath = argv[jsonIndex + 1];
    if (!jsonPath) {
      console.error("--json requires a file path");
      process.exit(2);
    }
    return { jsonPath };
  }
  return {};
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

// The unification commit date: rows created after this point were written by
// the corrected code and are far less likely to be mis-scaled.
const FIX_DATE = "2026-09-27";

async function main() {
  const { jsonPath } = parseArgs(process.argv);
  const sql = postgres(getDatabaseUrl(), { max: 1 });

  try {
    // Divergent-adapter flags: currency/provider pairs whose decimals table
    // disagreed between the two adapters before the unification.
    const moneyRows = (await sql`
      SELECT
        'payments' AS source,
        p.id,
        p.application_id,
        pc.provider,
        pc.mode,
        p.currency,
        p.amount_minor,
        p.status,
        p.created_at
      FROM payments p
      JOIN provider_connections pc ON pc.id = p.provider_connection_id
      WHERE (UPPER(p.currency) = 'ISK' AND pc.provider = 'paypal')
         OR (UPPER(p.currency) IN ('MGA', 'XAF') AND pc.provider = 'waffo')
      UNION ALL
      SELECT
        'refunds' AS source,
        r.id,
        r.application_id,
        pc.provider,
        pc.mode,
        p.currency,
        r.amount_minor,
        r.status,
        r.created_at
      FROM refunds r
      JOIN payments p ON p.id = r.payment_id
      JOIN provider_connections pc ON pc.id = r.provider_connection_id
      WHERE (UPPER(p.currency) = 'ISK' AND pc.provider = 'paypal')
         OR (UPPER(p.currency) IN ('MGA', 'XAF') AND pc.provider = 'waffo')
      ORDER BY created_at
    `) as unknown as Array<{
      source: string;
      id: string;
      application_id: string;
      provider: string;
      mode: string;
      currency: string;
      amount_minor: string | number | null;
      status: string;
      created_at: Date;
    }>;

    // Orders touched by a flagged payment (orders carry their own currency
    // and total; both must be reviewed together with the payment).
    const orderRows = (await sql`
      SELECT DISTINCT
        'orders' AS source,
        o.id,
        o.application_id,
        pc.provider,
        pc.mode,
        o.currency,
        o.total_amount_minor,
        o.status,
        o.created_at
      FROM orders o
      JOIN payments p ON p.order_id = o.id
      JOIN provider_connections pc ON pc.id = p.provider_connection_id
      WHERE (UPPER(o.currency) = 'ISK' AND pc.provider = 'paypal')
         OR (UPPER(o.currency) IN ('MGA', 'XAF') AND pc.provider = 'waffo')
      ORDER BY created_at
    `) as unknown as Array<{
      source: string;
      id: string;
      application_id: string;
      provider: string;
      mode: string;
      currency: string;
      total_amount_minor: string | number | null;
      status: string;
      created_at: Date;
    }>;

    // Wizard-era prices: every zero-decimal-currency price may have been
    // entered as display value x100 before the fix. Created-after-FIX_DATE
    // rows are "likely correct" but still listed for completeness.
    const priceRows = (await sql`
      SELECT
        pr.id,
        prod.application_id,
        prod.name AS product_name,
        pr.currency,
        pr.amount_minor,
        pr.created_at
      FROM prices pr
      JOIN products prod ON prod.id = pr.product_id
      WHERE UPPER(pr.currency) IN (
        'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
        'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF', 'ISK'
      )
      ORDER BY pr.created_at
    `) as unknown as Array<{
      id: string;
      application_id: string;
      product_name: string;
      currency: string;
      amount_minor: string | number;
      created_at: Date;
    }>;

    const flaggedMoney: FlaggedMoneyRow[] = [
      ...moneyRows.map((row) => ({
        source: row.source as FlaggedMoneyRow["source"],
        id: row.id,
        applicationId: row.application_id,
        provider: row.provider,
        mode: row.mode,
        currency: row.currency,
        amountMinor:
          row.amount_minor === null ? null : Number(row.amount_minor),
        status: row.status,
        createdAt: row.created_at.toISOString(),
        reason: `${row.provider} adapter pre-unification treated ${row.currency} as 2-decimal`,
      })),
      ...orderRows.map((row) => ({
        source: "orders" as const,
        id: row.id,
        applicationId: row.application_id,
        provider: row.provider,
        mode: row.mode,
        currency: row.currency,
        amountMinor:
          row.total_amount_minor === null
            ? null
            : Number(row.total_amount_minor),
        status: row.status,
        createdAt: row.created_at.toISOString(),
        reason: `order tied to a flagged ${row.provider} payment (${row.currency})`,
      })),
    ];

    const flaggedPrices: FlaggedPriceRow[] = priceRows.map((row) => ({
      source: "catalog.prices" as const,
      id: row.id,
      applicationId: row.application_id,
      productName: row.product_name,
      currency: row.currency,
      amountMinor: Number(row.amount_minor),
      createdAt: row.created_at.toISOString(),
      suspect: row.created_at.toISOString().slice(0, 10) < FIX_DATE,
      reason: "wizard pre-unification stored display input x100",
    }));

    const suspectPrices = flaggedPrices.filter((row) => row.suspect);

    console.log("=== Currency-decimals reconciliation report (read-only) ===");
    console.log("");
    console.log(
      `[1] Adapter-divergence rows (ISK@paypal, MGA/XAF@waffo): ${flaggedMoney.length}`,
    );
    for (const row of flaggedMoney) {
      console.log(
        `    ${row.source} ${row.id}  ${row.provider}/${row.mode}  ${row.currency} ${row.amountMinor ?? "null"} minor  ${row.status}  ${row.createdAt}`,
      );
    }
    console.log("");
    console.log(
      `[2] Zero-decimal-currency catalog prices: ${flaggedPrices.length} total, ${suspectPrices.length} created before ${FIX_DATE} (suspect)`,
    );
    for (const row of flaggedPrices) {
      console.log(
        `    price ${row.id}  ${row.productName}  ${row.currency} ${row.amountMinor} minor  ${row.suspect ? "SUSPECT" : "post-fix"}  ${row.createdAt}`,
      );
    }
    console.log("");
    if (flaggedMoney.length === 0 && suspectPrices.length === 0) {
      console.log("Result: nothing requires reconciliation.");
    } else {
      console.log(
        "Result: compare each flagged row against the provider's settlement records before correcting. This script does not write.",
      );
    }

    if (jsonPath) {
      const payload = {
        generatedAt: new Date().toISOString(),
        fixDate: FIX_DATE,
        adapterDivergenceRows: flaggedMoney,
        zeroDecimalPrices: flaggedPrices,
        summary: {
          adapterDivergenceRows: flaggedMoney.length,
          zeroDecimalPrices: flaggedPrices.length,
          suspectPrices: suspectPrices.length,
        },
      };
      await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
      console.log(`JSON report written to ${jsonPath}`);
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((error) => {
  console.error("reconciliation report failed:", error);
  process.exit(1);
});
