import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { applications } from "../applications/schema";
import { applicationCustomers } from "../customers/schema";

/**
 * Hosted customer billing portal sessions (#71).
 *
 * Created by the application backend through the SDK surface (mp_app_*
 * bearer), one session pins exactly one application customer and one
 * environment. The raw token is shown once and stored only as a SHA-256
 * hash — portal access cannot be reassigned client-side.
 */
export const portalSessions = pgTable(
  "portal_sessions",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    applicationCustomerId: text("application_customer_id")
      .notNull()
      .references(() => applicationCustomers.id, { onDelete: "cascade" }),
    environment: text("environment").default("test").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").default("active").notNull(),
    returnUrl: text("return_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("portal_sessions_token_hash_unique").on(table.tokenHash),
    index("portal_sessions_application_idx").on(
      table.applicationId,
      table.createdAt,
    ),
    check(
      "portal_sessions_environment_check",
      sql`${table.environment} IN ('test', 'live')`,
    ),
    check(
      "portal_sessions_status_check",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
  ],
);
