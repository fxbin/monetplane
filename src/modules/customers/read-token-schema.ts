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
import { applicationCustomers } from "./schema";

/**
 * Short-lived, customer-scoped read tokens (#138 end-state for #127).
 *
 * Issued by the application backend (credential-authenticated) for ONE
 * application customer; consumed by read endpoints (balances/entitlements)
 * from browsers on branded-host surfaces. Stored as a SHA-256 hash — the raw
 * token is shown once. Scoped to a single environment; expiry is mandatory.
 */
export const customerReadTokens = pgTable(
  "customer_read_tokens",
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("customer_read_tokens_token_hash_unique").on(table.tokenHash),
    index("customer_read_tokens_customer_idx").on(
      table.applicationId,
      table.applicationCustomerId,
    ),
    check(
      "customer_read_tokens_environment_check",
      sql`${table.environment} IN ('test', 'live')`,
    ),
  ],
);
