-- Usage metering engine first slice (#62): meter definitions, idempotent
-- usage events, and per-period aggregation inputs. Meters are application
-- definitions (shared across environments per the isolation ADR); usage
-- events carry the environment dimension.

CREATE TABLE "usage_meters" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL REFERENCES "applications" ("id") ON DELETE CASCADE,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"billing_scheme" text NOT NULL,
	"currency" text NOT NULL,
	"included_quantity" integer,
	"per_unit_amount_minor" bigint,
	"overage_unit_amount_minor" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_meters_application_key_unique" ON "usage_meters" ("application_id", "key");--> statement-breakpoint
ALTER TABLE "usage_meters" ADD CONSTRAINT "usage_meters_scheme_check" CHECK ("billing_scheme" IN ('per_unit', 'included_overage'));--> statement-breakpoint
ALTER TABLE "usage_meters" ADD CONSTRAINT "usage_meters_status_check" CHECK ("status" IN ('active', 'archived'));--> statement-breakpoint
ALTER TABLE "usage_meters" ADD CONSTRAINT "usage_meters_shape_check" CHECK (
  ("billing_scheme" = 'per_unit' AND "per_unit_amount_minor" IS NOT NULL AND "per_unit_amount_minor" >= 0 AND "included_quantity" IS NULL AND "overage_unit_amount_minor" IS NULL)
  OR
  ("billing_scheme" = 'included_overage' AND "included_quantity" IS NOT NULL AND "included_quantity" >= 0 AND "overage_unit_amount_minor" IS NOT NULL AND "overage_unit_amount_minor" >= 0 AND "per_unit_amount_minor" IS NULL)
);--> statement-breakpoint

CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL REFERENCES "applications" ("id") ON DELETE CASCADE,
	"environment" text NOT NULL,
	"meter_id" text NOT NULL REFERENCES "usage_meters" ("id") ON DELETE CASCADE,
	"application_customer_id" text NOT NULL REFERENCES "application_customers" ("id") ON DELETE CASCADE,
	"quantity" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idempotency_unique" ON "usage_events" ("application_id", "environment", "idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_events_meter_period_idx" ON "usage_events" ("meter_id", "environment", "occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_customer_idx" ON "usage_events" ("application_id", "environment", "application_customer_id");--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_quantity_check" CHECK ("quantity" > 0);--> statement-breakpoint
