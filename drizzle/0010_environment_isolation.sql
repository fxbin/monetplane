-- Environment isolation per docs/adr-environment-isolation.md (#49, implemented by #74).
-- Adds an immutable environment column ('test' | 'live') to billing runtime
-- entities, backfills legacy rows from provider connection mode where the
-- relation exists, defaults the remainder to 'test' with an operator report,
-- and widens idempotency unique keys to include the environment.

ALTER TABLE "orders" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_operations" ADD COLUMN "environment" text DEFAULT 'test' NOT NULL;--> statement-breakpoint

-- Backfill from provider connection mode where a direct relation exists.
UPDATE "payments" p SET "environment" = pc."mode" FROM "provider_connections" pc WHERE pc."id" = p."provider_connection_id";--> statement-breakpoint
UPDATE "subscriptions" s SET "environment" = pc."mode" FROM "provider_connections" pc WHERE pc."id" = s."provider_connection_id";--> statement-breakpoint
UPDATE "webhook_events" w SET "environment" = pc."mode" FROM "provider_connections" pc WHERE pc."id" = w."provider_connection_id";--> statement-breakpoint
UPDATE "billing_operations" b SET "environment" = pc."mode" FROM "provider_connections" pc WHERE pc."id" = b."provider_connection_id";--> statement-breakpoint
UPDATE "checkout_sessions" c SET "environment" = pc."mode" FROM "provider_connections" pc WHERE pc."id" = c."provider_connection_id";--> statement-breakpoint
UPDATE "orders" o SET "environment" = c."environment" FROM "checkout_sessions" c WHERE c."order_id" = o."id";--> statement-breakpoint
UPDATE "refunds" r SET "environment" = p."environment" FROM "payments" p WHERE p."id" = r."payment_id";--> statement-breakpoint
UPDATE "entitlement_grants" e SET "environment" = o."environment" FROM "orders" o WHERE o."id" = e."source_id" AND e."source_type" = 'order';--> statement-breakpoint
UPDATE "entitlement_grants" e SET "environment" = s."environment" FROM "subscriptions" s WHERE s."id" = e."source_id" AND e."source_type" = 'subscription';--> statement-breakpoint

-- Operator report: rows that could not be derived from a provider relation
-- keep the safe default 'test' (de-facto sandbox usage per the ADR). Emit
-- counts so operators can audit any mislabel risk.
DO $$
DECLARE
  defaulted_orders integer;
  defaulted_credits integer;
  defaulted_entitlements integer;
BEGIN
  SELECT count(*) INTO defaulted_orders FROM "orders" WHERE "environment" = 'test';
  SELECT count(*) INTO defaulted_credits FROM "credit_accounts" WHERE "environment" = 'test';
  SELECT count(*) INTO defaulted_entitlements FROM "entitlement_grants" WHERE "environment" = 'test';
  RAISE NOTICE 'environment backfill: orders defaulted to test=%, credit accounts defaulted to test=%, entitlement grants defaulted to test=% (pre-isolation data was de-facto sandbox per ADR)', defaulted_orders, defaulted_credits, defaulted_entitlements;
END
$$;--> statement-breakpoint

ALTER TABLE "orders" ADD CONSTRAINT "orders_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint

-- Environment is immutable after insert.
CREATE OR REPLACE FUNCTION "monetplane_environment_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."environment" IS DISTINCT FROM OLD."environment" THEN
    RAISE EXCEPTION 'environment column is immutable';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "orders_environment_immutable" BEFORE UPDATE ON "orders" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "payments_environment_immutable" BEFORE UPDATE ON "payments" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "subscriptions_environment_immutable" BEFORE UPDATE ON "subscriptions" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "refunds_environment_immutable" BEFORE UPDATE ON "refunds" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "credit_accounts_environment_immutable" BEFORE UPDATE ON "credit_accounts" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "credit_transactions_environment_immutable" BEFORE UPDATE ON "credit_transactions" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "credit_reservations_environment_immutable" BEFORE UPDATE ON "credit_reservations" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "entitlement_grants_environment_immutable" BEFORE UPDATE ON "entitlement_grants" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "billing_operations_environment_immutable" BEFORE UPDATE ON "billing_operations" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "checkout_sessions_environment_immutable" BEFORE UPDATE ON "checkout_sessions" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint
CREATE TRIGGER "webhook_events_environment_immutable" BEFORE UPDATE ON "webhook_events" FOR EACH ROW EXECUTE FUNCTION "monetplane_environment_immutable"();--> statement-breakpoint

-- Idempotency uniqueness gains the environment dimension (ADR §3).
DROP INDEX IF EXISTS "credit_accounts_scope_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "credit_accounts_scope_unique" ON "credit_accounts" ("application_id", "application_customer_id", "credit_type", "environment");--> statement-breakpoint
DROP INDEX IF EXISTS "credit_transactions_application_idempotency_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_application_idempotency_unique" ON "credit_transactions" ("application_id", "environment", "idempotency_key");--> statement-breakpoint
DROP INDEX IF EXISTS "credit_reservations_application_idempotency_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_application_idempotency_unique" ON "credit_reservations" ("application_id", "environment", "idempotency_key");--> statement-breakpoint
DROP INDEX IF EXISTS "entitlement_grants_application_idempotency_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_application_idempotency_unique" ON "entitlement_grants" ("application_id", "environment", "idempotency_key");--> statement-breakpoint

-- Covering indexes for the console's default environment-scoped reads.
DROP INDEX IF EXISTS "orders_application_idx";--> statement-breakpoint
CREATE INDEX "orders_application_idx" ON "orders" ("application_id", "environment");--> statement-breakpoint
DROP INDEX IF EXISTS "payments_application_idx";--> statement-breakpoint
CREATE INDEX "payments_application_idx" ON "payments" ("application_id", "environment");--> statement-breakpoint
DROP INDEX IF EXISTS "subscriptions_application_idx";--> statement-breakpoint
CREATE INDEX "subscriptions_application_idx" ON "subscriptions" ("application_id", "environment");--> statement-breakpoint
DROP INDEX IF EXISTS "checkout_sessions_application_idx";--> statement-breakpoint
CREATE INDEX "checkout_sessions_application_idx" ON "checkout_sessions" ("application_id", "environment");--> statement-breakpoint
