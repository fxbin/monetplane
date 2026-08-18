CREATE TABLE "applications" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "applications_slug_unique" ON "applications" USING btree ("slug");
--> statement-breakpoint
CREATE TABLE "application_domains" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "hostname" text NOT NULL,
  "kind" text DEFAULT 'billing' NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_domains" ADD CONSTRAINT "application_domains_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "application_domains_hostname_unique" ON "application_domains" USING btree ("hostname");
--> statement-breakpoint
CREATE INDEX "application_domains_application_idx" ON "application_domains" USING btree ("application_id");
--> statement-breakpoint
CREATE TABLE "application_branding" (
  "application_id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "logo_url" text,
  "primary_color" text,
  "support_email" text,
  "metadata" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_branding" ADD CONSTRAINT "application_branding_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "application_callback_origins" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "origin" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_callback_origins" ADD CONSTRAINT "application_callback_origins_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "application_callback_origins_unique" ON "application_callback_origins" USING btree ("application_id", "origin");
--> statement-breakpoint
CREATE INDEX "application_callback_origins_application_idx" ON "application_callback_origins" USING btree ("application_id");
--> statement-breakpoint
CREATE TABLE "application_credentials" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "name" text NOT NULL,
  "secret_hash" text NOT NULL,
  "secret_prefix" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "application_credentials_secret_hash_unique" ON "application_credentials" USING btree ("secret_hash");
--> statement-breakpoint
CREATE INDEX "application_credentials_application_idx" ON "application_credentials" USING btree ("application_id");
