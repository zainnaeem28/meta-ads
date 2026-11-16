CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idp_subject" varchar(64) NOT NULL,
	"email" varchar(320) NOT NULL,
	"note" varchar(500),
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_requests_state_ck" CHECK ("access_requests"."state" in ('pending', 'approved', 'declined'))
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"invited_by" uuid,
	"state" text DEFAULT 'invited' NOT NULL,
	"send_state" text DEFAULT 'pending' NOT NULL,
	"idp_invitation_id" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_state_ck" CHECK ("invitations"."state" in ('invited', 'accepted', 'expired', 'revoked')),
	CONSTRAINT "invitations_send_state_ck" CHECK ("invitations"."send_state" in ('pending', 'sent', 'send_failed')),
	CONSTRAINT "invitations_expires_ck" CHECK ("invitations"."expires_at" > "invitations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"signup_mode" text DEFAULT 'invited_only' NOT NULL,
	"first_admin_seeded_at" timestamp with time zone,
	"open_mode_verification_id" varchar(120),
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_single_ck" CHECK ("platform_settings"."id" = 1),
	CONSTRAINT "platform_settings_signup_mode_ck" CHECK ("platform_settings"."signup_mode" in ('invited_only', 'open'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idp_subject" varchar(64) NOT NULL,
	"email" varchar(320) NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"linked_via" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_ck" CHECK ("users"."role" in ('user', 'admin')),
	CONSTRAINT "users_status_ck" CHECK ("users"."status" in ('active', 'suspended', 'removed')),
	CONSTRAINT "users_linked_via_ck" CHECK ("users"."linked_via" in ('first_admin', 'invitation', 'access_request', 'open_signup')),
	CONSTRAINT "users_version_ck" CHECK ("users"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_requests_subject_pending_uq" ON "access_requests" USING btree ("idp_subject") WHERE "access_requests"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "access_requests_email_idx" ON "access_requests" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_email_invited_uq" ON "invitations" USING btree (lower("email")) WHERE "invitations"."state" = 'invited';--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_idp_invitation_id_uq" ON "invitations" USING btree ("idp_invitation_id");--> statement-breakpoint
CREATE INDEX "invitations_send_pending_idx" ON "invitations" USING btree ("created_at") WHERE "invitations"."send_state" = 'pending';--> statement-breakpoint
CREATE INDEX "invitations_created_idx" ON "invitations" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "invitations_expiry_idx" ON "invitations" USING btree ("expires_at") WHERE "invitations"."state" = 'invited';--> statement-breakpoint
CREATE UNIQUE INDEX "users_idp_subject_uq" ON "users" USING btree ("idp_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_admin_active_idx" ON "users" USING btree ("id") WHERE "users"."role" = 'admin' and "users"."status" = 'active';--> statement-breakpoint
CREATE INDEX "users_created_idx" ON "users" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2, §2.10): the account tables are read and written by both runtime roles (erasure runs in the worker);
-- platform_settings is a single configuration row that is never deleted. app_backup reads every table by default privilege (M0001).
GRANT SELECT, INSERT, UPDATE, DELETE ON "users", "invitations", "access_requests" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform_settings" TO app_api, app_worker;
