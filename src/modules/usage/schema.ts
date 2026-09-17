import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { applications } from "../applications/schema";
import { applicationCustomers } from "../customers/schema";

export const usageMeters = pgTable(
  "usage_meters",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    billingScheme: text("billing_scheme").notNull(),
    currency: text("currency").notNull(),
    includedQuantity: integer("included_quantity"),
    perUnitAmountMinor: bigint("per_unit_amount_minor", { mode: "number" }),
    overageUnitAmountMinor: bigint("overage_unit_amount_minor", {
      mode: "number",
    }),
    status: text("status").default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("usage_meters_application_key_unique").on(
      table.applicationId,
      table.key,
    ),
    check(
      "usage_meters_scheme_check",
      sql`${table.billingScheme} IN ('per_unit', 'included_overage')`,
    ),
    check(
      "usage_meters_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    environment: text("environment").default("test").notNull(),
    meterId: text("meter_id")
      .notNull()
      .references(() => usageMeters.id, { onDelete: "cascade" }),
    applicationCustomerId: text("application_customer_id")
      .notNull()
      .references(() => applicationCustomers.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("usage_events_idempotency_unique").on(
      table.applicationId,
      table.environment,
      table.idempotencyKey,
    ),
    index("usage_events_meter_period_idx").on(
      table.meterId,
      table.environment,
      table.occurredAt,
    ),
    index("usage_events_customer_idx").on(
      table.applicationId,
      table.environment,
      table.applicationCustomerId,
    ),
    check(
      "usage_events_environment_check",
      sql`${table.environment} IN ('test', 'live')`,
    ),
    check("usage_events_quantity_check", sql`${table.quantity} > 0`),
  ],
);
