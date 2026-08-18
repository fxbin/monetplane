import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Installation-level metadata only. Product-domain tables are introduced by
 * their owning modules in later P0 slices.
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
