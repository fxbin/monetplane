CREATE UNIQUE INDEX "provider_connections_id_application_unique" ON "provider_connections" USING btree ("id", "application_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_id_mode_unique" ON "provider_connections" USING btree ("id", "mode");
--> statement-breakpoint
CREATE TABLE "provider_catalog_mappings" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "environment" text NOT NULL,
  "monetplane_price_id" text NOT NULL,
  "provider" text NOT NULL,
  "provider_product_id" text,
  "source" text NOT NULL,
  "status" text NOT NULL,
  "verified_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_verified_at" timestamp with time zone,
  CONSTRAINT "provider_catalog_mappings_environment_check" CHECK ("provider_catalog_mappings"."environment" IN ('test', 'live')),
  CONSTRAINT "provider_catalog_mappings_source_check" CHECK ("provider_catalog_mappings"."source" IN ('linked', 'created')),
  CONSTRAINT "provider_catalog_mappings_status_check" CHECK ("provider_catalog_mappings"."status" IN ('pending', 'creating', 'synced', 'needs_reconciliation', 'failed')),
  CONSTRAINT "provider_catalog_mappings_product_shape_check" CHECK ("provider_catalog_mappings"."provider_product_id" IS NOT NULL OR "provider_catalog_mappings"."status" <> 'synced')
);
--> statement-breakpoint
ALTER TABLE "provider_catalog_mappings" ADD CONSTRAINT "provider_catalog_mappings_connection_app_fk" FOREIGN KEY ("provider_connection_id","application_id") REFERENCES "public"."provider_connections"("id","application_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_catalog_mappings" ADD CONSTRAINT "provider_catalog_mappings_connection_mode_fk" FOREIGN KEY ("provider_connection_id","environment") REFERENCES "public"."provider_connections"("id","mode") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_catalog_mappings" ADD CONSTRAINT "provider_catalog_mappings_price_fk" FOREIGN KEY ("monetplane_price_id") REFERENCES "public"."prices"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_catalog_mappings_scope_unique" ON "provider_catalog_mappings" USING btree ("application_id", "environment", "provider_connection_id", "monetplane_price_id");
--> statement-breakpoint
CREATE INDEX "provider_catalog_mappings_connection_idx" ON "provider_catalog_mappings" USING btree ("provider_connection_id");
--> statement-breakpoint
CREATE INDEX "provider_catalog_mappings_price_idx" ON "provider_catalog_mappings" USING btree ("monetplane_price_id");
