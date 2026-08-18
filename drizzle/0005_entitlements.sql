CREATE TABLE "entitlement_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "application_customer_id" text NOT NULL,
  "feature_key" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "source_event_id" text,
  "idempotency_key" text NOT NULL,
  "valid_from" timestamp with time zone NOT NULL,
  "valid_until" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "entitlement_grants_status_check" CHECK ("entitlement_grants"."status" IN ('active', 'revoked', 'expired')),
  CONSTRAINT "entitlement_grants_source_type_check" CHECK ("entitlement_grants"."source_type" IN ('order', 'subscription', 'admin')),
  CONSTRAINT "entitlement_grants_window_check" CHECK ("entitlement_grants"."valid_until" IS NULL OR "entitlement_grants"."valid_until" > "entitlement_grants"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_application_customer_id_application_customers_id_fk" FOREIGN KEY ("application_customer_id") REFERENCES "public"."application_customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_application_idempotency_unique" ON "entitlement_grants" USING btree ("application_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "entitlement_grants_access_idx" ON "entitlement_grants" USING btree ("application_id", "application_customer_id", "feature_key", "status");
--> statement-breakpoint
CREATE INDEX "entitlement_grants_source_idx" ON "entitlement_grants" USING btree ("application_id", "source_type", "source_id");
