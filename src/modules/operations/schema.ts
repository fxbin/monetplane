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
import { providerConnections } from "../providers/schema";

export const billingOperations = pgTable(
  "billing_operations",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "no action" }),
    providerResourceId: text("provider_resource_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("pending_provider").notNull(),
    normalizedResult: jsonb("normalized_result")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("billing_operations_idempotency_unique").on(
      table.applicationId,
      table.idempotencyKey,
    ),
    index("billing_operations_application_idx").on(table.applicationId),
    index("billing_operations_resource_idx").on(
      table.applicationId,
      table.resourceType,
      table.resourceId,
    ),
    index("billing_operations_status_idx").on(
      table.applicationId,
      table.status,
    ),
    check(
      "billing_operations_type_check",
      sql`${table.type} IN ('refund', 'cancel_subscription')`,
    ),
    check(
      "billing_operations_resource_type_check",
      sql`${table.resourceType} IN ('payment', 'subscription')`,
    ),
    check(
      "billing_operations_status_check",
      sql`${table.status} IN ('pending_provider', 'provider_succeeded', 'completed', 'needs_reconciliation', 'failed')`,
    ),
  ],
);
