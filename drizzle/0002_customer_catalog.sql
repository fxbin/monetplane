CREATE TABLE "customers" (
  "id" text PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_customers" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "customer_id" text NOT NULL,
  "external_customer_id" text NOT NULL,
  "email" text,
  "metadata" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_customers" ADD CONSTRAINT "application_customers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "application_customers" ADD CONSTRAINT "application_customers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "application_customers_external_unique" ON "application_customers" USING btree ("application_id", "external_customer_id");
--> statement-breakpoint
CREATE INDEX "application_customers_customer_idx" ON "application_customers" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "application_customers_application_idx" ON "application_customers" USING btree ("application_id");
--> statement-breakpoint
CREATE TABLE "products" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "products_status_check" CHECK ("products"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "products_application_key_unique" ON "products" USING btree ("application_id", "key");
--> statement-breakpoint
CREATE INDEX "products_application_idx" ON "products" USING btree ("application_id");
--> statement-breakpoint
CREATE TABLE "prices" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "key" text NOT NULL,
  "currency" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "billing_type" text NOT NULL,
  "recurring_interval" text,
  "interval_count" integer,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prices_amount_nonnegative_check" CHECK ("prices"."amount_minor" >= 0),
  CONSTRAINT "prices_currency_check" CHECK (char_length("prices"."currency") = 3 AND "prices"."currency" = upper("prices"."currency")),
  CONSTRAINT "prices_billing_type_check" CHECK ("prices"."billing_type" IN ('one_time', 'recurring')),
  CONSTRAINT "prices_billing_shape_check" CHECK ((
    "prices"."billing_type" = 'one_time'
    AND "prices"."recurring_interval" IS NULL
    AND "prices"."interval_count" IS NULL
  ) OR (
    "prices"."billing_type" = 'recurring'
    AND "prices"."recurring_interval" IN ('month', 'year')
    AND "prices"."interval_count" >= 1
  )),
  CONSTRAINT "prices_status_check" CHECK ("prices"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "prices_product_key_unique" ON "prices" USING btree ("product_id", "key");
--> statement-breakpoint
CREATE INDEX "prices_product_idx" ON "prices" USING btree ("product_id");
--> statement-breakpoint
CREATE TABLE "product_grant_configs" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "grant_type" text NOT NULL,
  "reference_key" text NOT NULL,
  "quantity" bigint,
  "metadata" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_grant_configs_type_check" CHECK ("product_grant_configs"."grant_type" IN ('entitlement', 'credit')),
  CONSTRAINT "product_grant_configs_quantity_check" CHECK ((
    "product_grant_configs"."grant_type" = 'entitlement' AND "product_grant_configs"."quantity" IS NULL
  ) OR (
    "product_grant_configs"."grant_type" = 'credit' AND "product_grant_configs"."quantity" > 0
  ))
);
--> statement-breakpoint
ALTER TABLE "product_grant_configs" ADD CONSTRAINT "product_grant_configs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "product_grant_configs_unique" ON "product_grant_configs" USING btree ("product_id", "grant_type", "reference_key");
--> statement-breakpoint
CREATE INDEX "product_grant_configs_product_idx" ON "product_grant_configs" USING btree ("product_id");
