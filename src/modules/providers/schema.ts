import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { applications } from "../applications/schema";
import { prices } from "../catalog/schema";

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
    // Composite FK targets for provider_catalog_mappings (#155): a mapping
    // row can only reference a connection of the SAME application and the
    // SAME environment/mode, enforced by the database on top of the
    // service-level diagnostics.
    uniqueIndex("provider_connections_id_application_unique").on(
      table.id,
      table.applicationId,
    ),
    uniqueIndex("provider_connections_id_mode_unique").on(table.id, table.mode),
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

/**
 * Price-level MonetPlane → provider product mapping (#155).
 *
 * One MonetPlane price maps to exactly one provider product per
 * (application, environment, connection). The unique index makes
 * competing links collide instead of silently rebinding a price to a
 * different provider product. Composite foreign keys keep the mapping on
 * the same application and the same environment as its connection at the
 * database level; the link service additionally validates connection
 * status and price ownership for diagnosable errors.
 *
 * `status` reserves the provisioning states of the auto-create follow-up
 * (#156); linking an existing product writes `synced` with source
 * `linked`. No Creem API key or webhook secret is ever stored here —
 * credentials stay encrypted on the connection row.
 */
export const providerCatalogMappings = pgTable(
  "provider_catalog_mappings",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id").notNull(),
    providerConnectionId: text("provider_connection_id").notNull(),
    environment: text("environment").notNull(),
    monetplanePriceId: text("monetplane_price_id").notNull(),
    provider: text("provider").notNull(),
    /**
     * NULL while a provisioning intent (#156: pending/creating, or a
     * failed attempt before the external create) has no external product
     * id yet; the shape check below keeps every other state non-null.
     */
    providerProductId: text("provider_product_id"),
    source: text("source").notNull(),
    status: text("status").notNull(),
    verifiedSnapshot: jsonb("verified_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("provider_catalog_mappings_scope_unique").on(
      table.applicationId,
      table.environment,
      table.providerConnectionId,
      table.monetplanePriceId,
    ),
    index("provider_catalog_mappings_connection_idx").on(
      table.providerConnectionId,
    ),
    index("provider_catalog_mappings_price_idx").on(table.monetplanePriceId),
    foreignKey({
      name: "provider_catalog_mappings_connection_app_fk",
      columns: [table.providerConnectionId, table.applicationId],
      foreignColumns: [
        providerConnections.id,
        providerConnections.applicationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "provider_catalog_mappings_connection_mode_fk",
      columns: [table.providerConnectionId, table.environment],
      foreignColumns: [providerConnections.id, providerConnections.mode],
    }).onDelete("cascade"),
    foreignKey({
      name: "provider_catalog_mappings_price_fk",
      columns: [table.monetplanePriceId],
      foreignColumns: [prices.id],
    }).onDelete("cascade"),
    check(
      "provider_catalog_mappings_environment_check",
      sql`${table.environment} IN ('test', 'live')`,
    ),
    check(
      "provider_catalog_mappings_source_check",
      sql`${table.source} IN ('linked', 'created')`,
    ),
    check(
      "provider_catalog_mappings_status_check",
      sql`${table.status} IN ('pending', 'creating', 'synced', 'needs_reconciliation', 'failed')`,
    ),
    // A provider product id is only absent while the mapping does not
    // claim a verified link: provisioning intents (#156 pending/creating),
    // definite failures, and — critically — uncertain outcomes parked in
    // needs_reconciliation where the create response was lost and the id
    // is UNKNOWN. Only synced rows must carry the id they were verified
    // against.
    check(
      "provider_catalog_mappings_product_shape_check",
      sql`${table.providerProductId} IS NOT NULL OR ${table.status} <> 'synced'`,
    ),
  ],
);
