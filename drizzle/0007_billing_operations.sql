CREATE TABLE "billing_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"type" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"provider_connection_id" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending_provider' NOT NULL,
	"normalized_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "billing_operations_type_check" CHECK ("billing_operations"."type" IN ('refund', 'cancel_subscription')),
	CONSTRAINT "billing_operations_resource_type_check" CHECK ("billing_operations"."resource_type" IN ('payment', 'subscription')),
	CONSTRAINT "billing_operations_status_check" CHECK ("billing_operations"."status" IN ('pending_provider', 'provider_succeeded', 'completed', 'needs_reconciliation', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_operations_idempotency_unique" ON "billing_operations" USING btree ("application_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "billing_operations_application_idx" ON "billing_operations" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "billing_operations_resource_idx" ON "billing_operations" USING btree ("application_id","resource_type","resource_id");
--> statement-breakpoint
CREATE INDEX "billing_operations_status_idx" ON "billing_operations" USING btree ("application_id","status");
