-- Credit lifecycle policies (#63): explicit grant buckets with validity
-- windows and deterministic consumption ordering. Balance mutations still
-- flow exclusively through the credit ledger (no silent rewrites); the
-- ledger type vocabulary gains 'grant.expired' for expiration reversals.

CREATE TABLE "credit_buckets" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL REFERENCES "applications" ("id") ON DELETE CASCADE,
	"environment" text NOT NULL,
	"application_customer_id" text NOT NULL REFERENCES "application_customers" ("id") ON DELETE CASCADE,
	"credit_account_id" text NOT NULL REFERENCES "credit_accounts" ("id") ON DELETE CASCADE,
	"credit_type" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"granted_amount" bigint NOT NULL,
	"remaining_amount" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "credit_buckets_account_idx" ON "credit_buckets" ("credit_account_id", "status", "expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_buckets_transaction_unique" ON "credit_buckets" ("transaction_id");--> statement-breakpoint
ALTER TABLE "credit_buckets" ADD CONSTRAINT "credit_buckets_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "credit_buckets" ADD CONSTRAINT "credit_buckets_source_check" CHECK ("source_type" IN ('purchase', 'subscription', 'promotion', 'admin', 'refund'));--> statement-breakpoint
ALTER TABLE "credit_buckets" ADD CONSTRAINT "credit_buckets_status_check" CHECK ("status" IN ('active', 'consumed', 'expired', 'reversed'));--> statement-breakpoint
ALTER TABLE "credit_buckets" ADD CONSTRAINT "credit_buckets_amount_check" CHECK ("granted_amount" > 0 AND "remaining_amount" >= 0 AND "remaining_amount" <= "granted_amount");--> statement-breakpoint

ALTER TABLE "credit_transactions" DROP CONSTRAINT "credit_transactions_type_check";--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_type_check" CHECK ("type" IN ('grant.purchase', 'grant.subscription', 'grant.promotion', 'debit.usage', 'reserve.usage', 'capture.usage', 'release.usage', 'refund.usage', 'adjustment.admin', 'grant.expired'));--> statement-breakpoint
