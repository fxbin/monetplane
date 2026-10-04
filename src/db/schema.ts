import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Installation-level metadata only. Product-domain tables are owned by their
 * modules and re-exported from this schema entrypoint for Drizzle.
 */
export const platformMetadata = pgTable("platform_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export * from "../modules/applications/schema";
export * from "../modules/catalog/schema";
export * from "../modules/commerce/schema";
export * from "../modules/credits/schema";
export * from "../modules/customers/read-token-schema";
// Every module schema that declares pgTable tables must be re-exported
// here: drizzle.config.ts points at this file, and an incomplete baseline
// makes `pnpm db:generate` produce wrong diffs (project review 2026-10-04,
// finding 2.1 — enforced by tests/db-schema-consistency.test.ts).
export * from "../modules/customers/schema";
export * from "../modules/entitlements/schema";
export * from "../modules/operations/audit-schema";
export * from "../modules/operations/schema";
export * from "../modules/portal/schema";
export * from "../modules/providers/schema";
export * from "../modules/team/schema";
export * from "../modules/usage/schema";
export * from "../modules/webhooks/schema";
