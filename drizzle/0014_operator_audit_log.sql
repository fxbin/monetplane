-- Operator audit log (#66): immutable, application-scoped records for
-- security- and money-sensitive console mutations. Append-only enforced at
-- the database level; metadata is redacted before persisting (no secrets).

CREATE TABLE "operator_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text REFERENCES "applications" ("id") ON DELETE CASCADE,
	"environment" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_label" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"correlation_id" text,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "operator_audit_application_idx" ON "operator_audit_log" ("application_id", "created_at");--> statement-breakpoint
CREATE INDEX "operator_audit_action_idx" ON "operator_audit_log" ("application_id", "action");--> statement-breakpoint
CREATE INDEX "operator_audit_actor_idx" ON "operator_audit_log" ("actor_id", "created_at");--> statement-breakpoint
ALTER TABLE "operator_audit_log" ADD CONSTRAINT "operator_audit_environment_check" CHECK ("environment" IN ('test', 'live'));--> statement-breakpoint
ALTER TABLE "operator_audit_log" ADD CONSTRAINT "operator_audit_actor_check" CHECK ("actor_type" IN ('admin_session', 'system'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "monetplane_audit_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'operator_audit_log is append-only';
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "operator_audit_log_immutable" BEFORE UPDATE OR DELETE ON "operator_audit_log" FOR EACH ROW EXECUTE FUNCTION "monetplane_audit_append_only"();--> statement-breakpoint
