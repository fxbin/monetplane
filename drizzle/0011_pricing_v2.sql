-- Pricing model v2 (#64): weekly recurring intervals, provider-neutral
-- trial configuration, price archival lifecycle, and commercial-terms
-- snapshots on subscription items so historical subscriptions keep the
-- terms they were created under.

ALTER TABLE "prices" DROP CONSTRAINT IF EXISTS "prices_billing_shape_check";--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_billing_shape_check" CHECK (
  (
    "billing_type" = 'one_time'
    AND "recurring_interval" IS NULL
    AND "interval_count" IS NULL
  ) OR (
    "billing_type" = 'recurring'
    AND "recurring_interval" IN ('week', 'month', 'year')
    AND "interval_count" >= 1
  )
);--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "trial_period_days" integer;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_trial_check" CHECK ("trial_period_days" IS NULL OR "trial_period_days" >= 1);--> statement-breakpoint
ALTER TABLE "prices" DROP CONSTRAINT IF EXISTS "prices_status_check";--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_status_check" CHECK ("status" IN ('active', 'archived'));--> statement-breakpoint
UPDATE "prices" SET "status" = 'active' WHERE "status" IS NULL;--> statement-breakpoint

ALTER TABLE "subscription_items" ADD COLUMN "unit_amount_minor" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD COLUMN "currency" text NOT NULL DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE "subscription_items" ADD COLUMN "recurring_interval" text;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD COLUMN "trial_period_days" integer;--> statement-breakpoint
-- Backfill commercial-terms snapshots from the referenced prices.
UPDATE "subscription_items" si SET
  "unit_amount_minor" = p."amount_minor",
  "currency" = p."currency",
  "recurring_interval" = p."recurring_interval",
  "trial_period_days" = p."trial_period_days"
FROM "prices" p WHERE p."id" = si."price_id";--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_amount_check" CHECK ("unit_amount_minor" >= 0);--> statement-breakpoint
