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

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").default("active").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("products_application_key_unique").on(
      table.applicationId,
      table.key,
    ),
    index("products_application_idx").on(table.applicationId),
    check("products_status_check", sql`${table.status} IN ('active', 'archived')`),
  ],
);

export const prices = pgTable(
  "prices",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    billingType: text("billing_type").notNull(),
    recurringInterval: text("recurring_interval"),
    intervalCount: integer("interval_count"),
    status: text("status").default("active").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("prices_product_key_unique").on(table.productId, table.key),
    index("prices_product_idx").on(table.productId),
    check("prices_amount_nonnegative_check", sql`${table.amountMinor} >= 0`),
    check(
      "prices_currency_check",
      sql`char_length(${table.currency}) = 3 AND ${table.currency} = upper(${table.currency})`,
    ),
    check(
      "prices_billing_type_check",
      sql`${table.billingType} IN ('one_time', 'recurring')`,
    ),
    check(
      "prices_billing_shape_check",
      sql`(
        ${table.billingType} = 'one_time'
        AND ${table.recurringInterval} IS NULL
        AND ${table.intervalCount} IS NULL
      ) OR (
        ${table.billingType} = 'recurring'
        AND ${table.recurringInterval} IN ('month', 'year')
        AND ${table.intervalCount} >= 1
      )`,
    ),
    check("prices_status_check", sql`${table.status} IN ('active', 'archived')`),
  ],
);

export const productGrantConfigs = pgTable(
  "product_grant_configs",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    grantType: text("grant_type").notNull(),
    referenceKey: text("reference_key").notNull(),
    quantity: bigint("quantity", { mode: "number" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("product_grant_configs_unique").on(
      table.productId,
      table.grantType,
      table.referenceKey,
    ),
    index("product_grant_configs_product_idx").on(table.productId),
    check(
      "product_grant_configs_type_check",
      sql`${table.grantType} IN ('entitlement', 'credit')`,
    ),
    check(
      "product_grant_configs_quantity_check",
      sql`(
        ${table.grantType} = 'entitlement' AND ${table.quantity} IS NULL
      ) OR (
        ${table.grantType} = 'credit' AND ${table.quantity} > 0
      )`,
    ),
  ],
);
