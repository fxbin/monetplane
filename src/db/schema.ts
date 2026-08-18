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
export * from "../modules/customers/schema";
