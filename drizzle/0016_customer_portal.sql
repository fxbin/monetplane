-- Hosted customer billing portal (#71): short-lived, single-customer portal
-- sessions created by the application backend with its SDK credential.
-- A session pins application + application customer + environment; the token
-- is stored only as a SHA-256 hash and can never be reassigned to another
-- customer or application client-side.

CREATE TABLE "portal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"application_customer_id" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"return_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "applications" ("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_application_customer_id_fk" FOREIGN KEY ("application_customer_id") REFERENCES "application_customers" ("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_sessions_token_hash_unique" ON "portal_sessions" ("token_hash");--> statement-breakpoint
CREATE INDEX "portal_sessions_application_idx" ON "portal_sessions" ("application_id", "created_at");--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_status_check" CHECK ("status" IN ('active', 'revoked'));--> statement-breakpoint
-- Customer-initiated portal actions are first-class audit actors (#71).
ALTER TABLE "operator_audit_log" DROP CONSTRAINT "operator_audit_actor_check";--> statement-breakpoint
ALTER TABLE "operator_audit_log" ADD CONSTRAINT "operator_audit_actor_check" CHECK ("actor_type" IN ('admin_session', 'system', 'customer_portal'));
