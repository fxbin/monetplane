import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { applications } from "../applications/schema";
import { applicationCustomers } from "../customers/schema";

export const entitlementGrants = pgTable(
  "entitlement_grants",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    applicationCustomerId: text("application_customer_id")
      .notNull()
      .references(() => applicationCustomers.id, { onDelete: "no action" }),
    featureKey: text("feature_key").notNull(),
    status: text("status").default("active").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceEventId: text("source_event_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("entitlement_grants_application_idempotency_unique").on(
      table.applicationId,
      table.idempotencyKey,
    ),
    index("entitlement_grants_access_idx").on(
      table.applicationId,
      table.applicationCustomerId,
      table.featureKey,
      table.status,
    ),
    index("entitlement_grants_source_idx").on(
      table.applicationId,
      table.sourceType,
      table.sourceId,
    ),
    check(
      "entitlement_grants_status_check",
      sql`${table.status} IN ('active', 'revoked', 'expired')`,
    ),
    check(
      "entitlement_grants_source_type_check",
      sql`${table.sourceType} IN ('order', 'subscription', 'admin')`,
    ),
    check(
      "entitlement_grants_window_check",
      sql`${table.validUntil} IS NULL OR ${table.validUntil} > ${table.validFrom}`,
    ),
  ],
);
