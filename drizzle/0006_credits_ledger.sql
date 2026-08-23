CREATE TABLE "credit_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "application_customer_id" text NOT NULL,
  "credit_type" text NOT NULL,
  "available_balance" bigint DEFAULT 0 NOT NULL,
  "reserved_balance" bigint DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_accounts_available_nonnegative_check" CHECK ("credit_accounts"."available_balance" >= 0),
  CONSTRAINT "credit_accounts_reserved_nonnegative_check" CHECK ("credit_accounts"."reserved_balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_application_customer_id_application_customers_id_fk" FOREIGN KEY ("application_customer_id") REFERENCES "public"."application_customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_accounts_scope_unique" ON "credit_accounts" USING btree ("application_id", "application_customer_id", "credit_type");
--> statement-breakpoint
CREATE INDEX "credit_accounts_customer_idx" ON "credit_accounts" USING btree ("application_id", "application_customer_id");
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "application_customer_id" text NOT NULL,
  "credit_account_id" text NOT NULL,
  "type" text NOT NULL,
  "amount" bigint NOT NULL,
  "available_after" bigint NOT NULL,
  "reserved_after" bigint NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_transactions_type_check" CHECK ("credit_transactions"."type" IN ('grant.purchase', 'grant.subscription', 'grant.promotion', 'debit.usage', 'reserve.usage', 'capture.usage', 'release.usage', 'refund.usage', 'adjustment.admin')),
  CONSTRAINT "credit_transactions_amount_nonzero_check" CHECK ("credit_transactions"."amount" <> 0),
  CONSTRAINT "credit_transactions_available_nonnegative_check" CHECK ("credit_transactions"."available_after" >= 0),
  CONSTRAINT "credit_transactions_reserved_nonnegative_check" CHECK ("credit_transactions"."reserved_after" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_application_customer_id_application_customers_id_fk" FOREIGN KEY ("application_customer_id") REFERENCES "public"."application_customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_application_idempotency_unique" ON "credit_transactions" USING btree ("application_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "credit_transactions_account_idx" ON "credit_transactions" USING btree ("credit_account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "credit_transactions_source_idx" ON "credit_transactions" USING btree ("application_id", "source_type", "source_id");
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "application_customer_id" text NOT NULL,
  "credit_account_id" text NOT NULL,
  "reserved_amount" bigint NOT NULL,
  "captured_amount" bigint DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "reference_type" text NOT NULL,
  "reference_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_reservations_status_check" CHECK ("credit_reservations"."status" IN ('active', 'captured', 'released', 'expired')),
  CONSTRAINT "credit_reservations_reserved_positive_check" CHECK ("credit_reservations"."reserved_amount" > 0),
  CONSTRAINT "credit_reservations_captured_range_check" CHECK ("credit_reservations"."captured_amount" >= 0 AND "credit_reservations"."captured_amount" <= "credit_reservations"."reserved_amount")
);
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_application_customer_id_application_customers_id_fk" FOREIGN KEY ("application_customer_id") REFERENCES "public"."application_customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_application_idempotency_unique" ON "credit_reservations" USING btree ("application_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "credit_reservations_account_idx" ON "credit_reservations" USING btree ("credit_account_id", "status");
--> statement-breakpoint
CREATE INDEX "credit_reservations_reference_idx" ON "credit_reservations" USING btree ("application_id", "reference_type", "reference_id");
