CREATE TABLE "customer_read_tokens" (
  "id" text PRIMARY KEY,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "application_customer_id" text NOT NULL REFERENCES "application_customers"("id") ON DELETE CASCADE,
  "environment" text DEFAULT 'test' NOT NULL,
  "token_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_read_tokens_token_hash_unique" ON "customer_read_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX "customer_read_tokens_customer_idx" ON "customer_read_tokens" ("application_id","application_customer_id");--> statement-breakpoint
ALTER TABLE "customer_read_tokens" ADD CONSTRAINT "customer_read_tokens_environment_check" CHECK ("environment" IN ('test', 'live'));
