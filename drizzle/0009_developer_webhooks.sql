CREATE TABLE "webhook_endpoints" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "mode" text NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "secret_ciphertext" text NOT NULL,
  "secret_prefix" text NOT NULL,
  "event_types" jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disabled_at" timestamp with time zone,
  CONSTRAINT "webhook_endpoints_mode_check" CHECK ("webhook_endpoints"."mode" IN ('test', 'live')),
  CONSTRAINT "webhook_endpoints_status_check" CHECK ("webhook_endpoints"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "endpoint_id" text NOT NULL,
  "application_id" text NOT NULL,
  "mode" text NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "provider_connection_id" text,
  "external_customer_id" text,
  "order_id" text,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "response_status" integer,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  CONSTRAINT "webhook_deliveries_mode_check" CHECK ("webhook_deliveries"."mode" IN ('test', 'live')),
  CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT "webhook_deliveries_attempt_count_check" CHECK ("webhook_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_app_mode_name_unique" ON "webhook_endpoints" USING btree ("application_id","mode","name");
--> statement-breakpoint
CREATE INDEX "webhook_endpoints_application_mode_idx" ON "webhook_endpoints" USING btree ("application_id","mode");
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_unique" ON "webhook_deliveries" USING btree ("endpoint_id","event_id");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_application_mode_idx" ON "webhook_deliveries" USING btree ("application_id","mode");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("application_id","status");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_provider_idx" ON "webhook_deliveries" USING btree ("application_id","provider_connection_id");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_customer_idx" ON "webhook_deliveries" USING btree ("application_id","external_customer_id");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_order_idx" ON "webhook_deliveries" USING btree ("application_id","order_id");
