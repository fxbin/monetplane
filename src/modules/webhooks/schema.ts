import { sql } from "drizzle-orm";
import {
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

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretPrefix: text("secret_prefix").notNull(),
    eventTypes: jsonb("event_types").$type<string[]>().notNull(),
    status: text("status").default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("webhook_endpoints_app_mode_name_unique").on(
      table.applicationId,
      table.mode,
      table.name,
    ),
    index("webhook_endpoints_application_mode_idx").on(
      table.applicationId,
      table.mode,
    ),
    check(
      "webhook_endpoints_mode_check",
      sql`${table.mode} IN ('test', 'live')`,
    ),
    check(
      "webhook_endpoints_status_check",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    providerConnectionId: text("provider_connection_id"),
    externalCustomerId: text("external_customer_id"),
    orderId: text("order_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    responseStatus: integer("response_status"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_endpoint_event_unique").on(
      table.endpointId,
      table.eventId,
    ),
    index("webhook_deliveries_application_mode_idx").on(
      table.applicationId,
      table.mode,
    ),
    index("webhook_deliveries_status_idx").on(
      table.applicationId,
      table.status,
    ),
    index("webhook_deliveries_provider_idx").on(
      table.applicationId,
      table.providerConnectionId,
    ),
    index("webhook_deliveries_customer_idx").on(
      table.applicationId,
      table.externalCustomerId,
    ),
    index("webhook_deliveries_order_idx").on(
      table.applicationId,
      table.orderId,
    ),
    check(
      "webhook_deliveries_mode_check",
      sql`${table.mode} IN ('test', 'live')`,
    ),
    check(
      "webhook_deliveries_status_check",
      sql`${table.status} IN ('pending', 'succeeded', 'failed')`,
    ),
    check(
      "webhook_deliveries_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);
