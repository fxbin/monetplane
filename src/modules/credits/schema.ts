import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { applications } from "../applications/schema";
import { applicationCustomers } from "../customers/schema";

export const creditAccounts = pgTable(
  "credit_accounts",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    applicationCustomerId: text("application_customer_id")
      .notNull()
      .references(() => applicationCustomers.id, { onDelete: "no action" }),
    creditType: text("credit_type").notNull(),
    availableBalance: bigint("available_balance", { mode: "number" })
      .default(0)
      .notNull(),
    reservedBalance: bigint("reserved_balance", { mode: "number" })
      .default(0)
      .notNull(),
    version: integer("version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("credit_accounts_scope_unique").on(
      table.applicationId,
      table.applicationCustomerId,
      table.creditType,
    ),
    index("credit_accounts_customer_idx").on(
      table.applicationId,
      table.applicationCustomerId,
    ),
    check(
      "credit_accounts_available_nonnegative_check",
      sql`${table.availableBalance} >= 0`,
    ),
    check(
      "credit_accounts_reserved_nonnegative_check",
      sql`${table.reservedBalance} >= 0`,
    ),
  ],
);

export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    applicationCustomerId: text("application_customer_id")
      .notNull()
      .references(() => applicationCustomers.id, { onDelete: "no action" }),
    creditAccountId: text("credit_account_id")
      .notNull()
      .references(() => creditAccounts.id, { onDelete: "no action" }),
    type: text("type").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    availableAfter: bigint("available_after", { mode: "number" }).notNull(),
    reservedAfter: bigint("reserved_after", { mode: "number" }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("credit_transactions_application_idempotency_unique").on(
      table.applicationId,
      table.idempotencyKey,
    ),
    index("credit_transactions_account_idx").on(
      table.creditAccountId,
      table.createdAt,
    ),
    index("credit_transactions_source_idx").on(
      table.applicationId,
      table.sourceType,
      table.sourceId,
    ),
    check(
      "credit_transactions_type_check",
      sql`${table.type} IN ('grant.purchase', 'grant.subscription', 'grant.promotion', 'debit.usage', 'reserve.usage', 'capture.usage', 'release.usage', 'refund.usage', 'adjustment.admin')`,
    ),
    check("credit_transactions_amount_nonzero_check", sql`${table.amount} <> 0`),
    check(
      "credit_transactions_available_nonnegative_check",
      sql`${table.availableAfter} >= 0`,
    ),
    check(
      "credit_transactions_reserved_nonnegative_check",
      sql`${table.reservedAfter} >= 0`,
    ),
  ],
);

export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    applicationCustomerId: text("application_customer_id")
      .notNull()
      .references(() => applicationCustomers.id, { onDelete: "no action" }),
    creditAccountId: text("credit_account_id")
      .notNull()
      .references(() => creditAccounts.id, { onDelete: "no action" }),
    reservedAmount: bigint("reserved_amount", { mode: "number" }).notNull(),
    capturedAmount: bigint("captured_amount", { mode: "number" })
      .default(0)
      .notNull(),
    status: text("status").default("active").notNull(),
    referenceType: text("reference_type").notNull(),
    referenceId: text("reference_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("credit_reservations_application_idempotency_unique").on(
      table.applicationId,
      table.idempotencyKey,
    ),
    index("credit_reservations_account_idx").on(
      table.creditAccountId,
      table.status,
    ),
    index("credit_reservations_reference_idx").on(
      table.applicationId,
      table.referenceType,
      table.referenceId,
    ),
    check(
      "credit_reservations_status_check",
      sql`${table.status} IN ('active', 'captured', 'released', 'expired')`,
    ),
    check(
      "credit_reservations_reserved_positive_check",
      sql`${table.reservedAmount} > 0`,
    ),
    check(
      "credit_reservations_captured_range_check",
      sql`${table.capturedAmount} >= 0 AND ${table.capturedAmount} <= ${table.reservedAmount}`,
    ),
  ],
);
