CREATE TABLE "orders" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "application_customer_id" text NOT NULL,
  "billing_mode" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "currency" text NOT NULL,
  "total_amount_minor" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "orders_billing_mode_check" CHECK ("orders"."billing_mode" IN ('one_time', 'subscription')),
  CONSTRAINT "orders_status_check" CHECK ("orders"."status" IN ('pending', 'paid', 'failed', 'refunded')),
  CONSTRAINT "orders_total_nonnegative_check" CHECK ("orders"."total_amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_application_customer_id_application_customers_id_fk" FOREIGN KEY ("application_customer_id") REFERENCES "public"."application_customers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "orders_application_idx" ON "orders" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("application_customer_id");
--> statement-breakpoint
CREATE TABLE "order_items" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL,
  "product_id" text NOT NULL,
  "price_id" text NOT NULL,
  "quantity" integer NOT NULL,
  "unit_amount_minor" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" > 0),
  CONSTRAINT "order_items_amount_check" CHECK ("order_items"."unit_amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");
--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "order_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "status" text DEFAULT 'creating' NOT NULL,
  "provider_checkout_id" text,
  "checkout_url" text,
  "success_url" text NOT NULL,
  "cancel_url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "checkout_sessions_status_check" CHECK ("checkout_sessions"."status" IN ('creating', 'open', 'completed', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "checkout_sessions_application_idx" ON "checkout_sessions" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "checkout_sessions_order_idx" ON "checkout_sessions" USING btree ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_provider_checkout_unique" ON "checkout_sessions" USING btree ("provider_connection_id", "provider_checkout_id");
--> statement-breakpoint
CREATE TABLE "payments" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "order_id" text,
  "customer_id" text,
  "provider_connection_id" text NOT NULL,
  "provider_payment_id" text NOT NULL,
  "status" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('pending', 'succeeded', 'failed', 'refunded')),
  CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_unique" ON "payments" USING btree ("provider_connection_id", "provider_payment_id");
--> statement-breakpoint
CREATE INDEX "payments_application_idx" ON "payments" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");
--> statement-breakpoint
CREATE TABLE "refunds" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "order_id" text,
  "payment_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "provider_refund_id" text NOT NULL,
  "status" text NOT NULL,
  "amount_minor" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT "refunds_amount_check" CHECK ("refunds"."amount_minor" IS NULL OR "refunds"."amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_refund_unique" ON "refunds" USING btree ("provider_connection_id", "provider_refund_id");
--> statement-breakpoint
CREATE INDEX "refunds_application_idx" ON "refunds" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");
--> statement-breakpoint
CREATE TABLE "subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "application_customer_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "provider_subscription_id" text NOT NULL,
  "status" text NOT NULL,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" IN ('pending', 'active', 'past_due', 'cancelled', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_application_customer_id_application_customers_id_fk" FOREIGN KEY ("application_customer_id") REFERENCES "public"."application_customers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_subscription_unique" ON "subscriptions" USING btree ("provider_connection_id", "provider_subscription_id");
--> statement-breakpoint
CREATE INDEX "subscriptions_application_idx" ON "subscriptions" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "subscriptions_customer_idx" ON "subscriptions" USING btree ("application_customer_id");
--> statement-breakpoint
CREATE TABLE "subscription_items" (
  "id" text PRIMARY KEY NOT NULL,
  "subscription_id" text NOT NULL,
  "product_id" text NOT NULL,
  "price_id" text NOT NULL,
  "quantity" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "subscription_items_quantity_check" CHECK ("subscription_items"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_items_subscription_price_unique" ON "subscription_items" USING btree ("subscription_id", "price_id");
--> statement-breakpoint
CREATE INDEX "subscription_items_subscription_idx" ON "subscription_items" USING btree ("subscription_id");
--> statement-breakpoint
CREATE TABLE "webhook_events" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "provider_connection_id" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "provider_event_name" text NOT NULL,
  "normalized_type" text NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "raw_body" text NOT NULL,
  "normalized_event" jsonb NOT NULL,
  "error_message" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" IN ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_unique" ON "webhook_events" USING btree ("provider_connection_id", "provider_event_id");
--> statement-breakpoint
CREATE INDEX "webhook_events_application_idx" ON "webhook_events" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");
