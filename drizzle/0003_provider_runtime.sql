CREATE TABLE "provider_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "provider" text NOT NULL,
  "name" text NOT NULL,
  "mode" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "encrypted_credentials" text NOT NULL,
  "metadata" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "provider_connections_mode_check" CHECK ("provider_connections"."mode" IN ('test', 'live')),
  CONSTRAINT "provider_connections_status_check" CHECK ("provider_connections"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_app_provider_name_unique" ON "provider_connections" USING btree ("application_id", "provider", "name");
--> statement-breakpoint
CREATE INDEX "provider_connections_application_idx" ON "provider_connections" USING btree ("application_id");
