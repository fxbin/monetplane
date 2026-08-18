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

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    mode: text("mode").notNull(),
    status: text("status").default("active").notNull(),
    encryptedCredentials: text("encrypted_credentials").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("provider_connections_app_provider_name_unique").on(
      table.applicationId,
      table.provider,
      table.name,
    ),
    index("provider_connections_application_idx").on(table.applicationId),
    check(
      "provider_connections_mode_check",
      sql`${table.mode} IN ('test', 'live')`,
    ),
    check(
      "provider_connections_status_check",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
  ],
);
