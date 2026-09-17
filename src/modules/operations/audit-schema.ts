import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { applications } from "../applications/schema";

/**
 * Operator audit log (#66) — append-only records for sensitive console
 * mutations. Immutability is enforced by a database trigger; metadata is
 * redacted before insert so plaintext secrets can never appear.
 */
export const operatorAuditLog = pgTable(
  "operator_audit_log",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
    environment: text("environment"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    correlationId: text("correlation_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("operator_audit_application_idx").on(
      table.applicationId,
      table.createdAt,
    ),
    index("operator_audit_action_idx").on(table.applicationId, table.action),
    index("operator_audit_actor_idx").on(table.actorId, table.createdAt),
    check(
      "operator_audit_environment_check",
      sql`${table.environment} IS NULL OR ${table.environment} IN ('test', 'live')`,
    ),
    check(
      "operator_audit_actor_check",
      sql`${table.actorType} IN ('admin_session', 'system')`,
    ),
  ],
);
