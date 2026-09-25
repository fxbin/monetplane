-- Console team workspace (#70): durable operator identities, membership
-- roles, and restricted application scoping for the admin console.
-- SDK application credentials (mp_app_*) remain a separate machine-to-machine
-- system and never authenticate against these tables.

CREATE TABLE "operators" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operators_email_unique" ON "operators" ("email");--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_status_check" CHECK ("status" IN ('active', 'disabled'));--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"role" text NOT NULL,
	"application_scope" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators" ("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_operator_unique" ON "workspace_members" ("operator_id");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_check" CHECK ("role" IN ('owner', 'admin', 'developer', 'support', 'viewer'));--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_scope_check" CHECK ("application_scope" IN ('all', 'restricted'));--> statement-breakpoint
CREATE TABLE "member_application_access" (
	"member_id" text NOT NULL,
	"application_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_application_access_member_id_application_id_pk" PRIMARY KEY ("member_id", "application_id")
);
--> statement-breakpoint
ALTER TABLE "member_application_access" ADD CONSTRAINT "member_application_access_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "workspace_members" ("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member_application_access" ADD CONSTRAINT "member_application_access_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "applications" ("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "member_access_application_idx" ON "member_application_access" ("application_id");--> statement-breakpoint
CREATE TABLE "operator_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"application_scope" text DEFAULT 'all' NOT NULL,
	"application_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_invitations_token_unique" ON "operator_invitations" ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_invitations_email_idx" ON "operator_invitations" ("email");--> statement-breakpoint
ALTER TABLE "operator_invitations" ADD CONSTRAINT "operator_invitations_role_check" CHECK ("role" IN ('owner', 'admin', 'developer', 'support', 'viewer'));--> statement-breakpoint
ALTER TABLE "operator_invitations" ADD CONSTRAINT "operator_invitations_scope_check" CHECK ("application_scope" IN ('all', 'restricted'));--> statement-breakpoint
ALTER TABLE "operator_invitations" ADD CONSTRAINT "operator_invitations_status_check" CHECK ("status" IN ('pending', 'accepted', 'revoked'));
