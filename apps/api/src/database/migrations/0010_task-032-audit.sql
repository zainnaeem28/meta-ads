CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_user_id" uuid,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" varchar(120),
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	CONSTRAINT "admin_alerts_kind_ck" CHECK ("admin_alerts"."kind" in ('campaign_deletion_stuck', 'account_erasure_stuck', 'job_burst', 'provider_auth_spike', 'admin_role_changed', 'reservation_inconsistency', 'key_unseal_failed', 'keys_disabled_all')),
	CONSTRAINT "admin_alerts_counts_ck" CHECK (jsonb_typeof("admin_alerts"."counts") = 'object')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_type" text NOT NULL,
	"action" varchar(64) NOT NULL,
	"object_type" varchar(32) NOT NULL,
	"object_id" uuid,
	"outcome" text NOT NULL,
	"request_id" varchar(64),
	CONSTRAINT "audit_events_actor_type_ck" CHECK ("audit_events"."actor_type" in ('user', 'admin', 'system', 'operator')),
	CONSTRAINT "audit_events_outcome_ck" CHECK ("audit_events"."outcome" in ('allowed', 'denied', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_alerts_open_dedupe_uq" ON "admin_alerts" USING btree ("dedupe_key") WHERE "admin_alerts"."acknowledged_at" is null;--> statement-breakpoint
CREATE INDEX "admin_alerts_queue_idx" ON "admin_alerts" USING btree ("acknowledged_at" nulls first,"raised_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_at_idx" ON "audit_events" USING btree ("actor_id","at");--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2, §2.10): audit_events is append-only for the runtime roles (no UPDATE, DELETE or TRUNCATE);
-- admin_alerts is acknowledged in place, never deleted. app_backup already reads every table by default privilege (M0001).
GRANT SELECT, INSERT ON "audit_events" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "admin_alerts" TO app_api, app_worker;
