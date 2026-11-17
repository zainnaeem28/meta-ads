CREATE TABLE "thumbstopper_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"callout_text" varchar(80) NOT NULL,
	"provider_model" varchar(120) NOT NULL,
	"output_media_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"cause_class" text,
	"cause_message" varchar(300),
	"reuse_hash" char(64) NOT NULL,
	"key_id" uuid,
	"key_version" integer,
	"call_count" smallint DEFAULT 0 NOT NULL,
	"submitting_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thumbstopper_jobs_state_ck" CHECK ("thumbstopper_jobs"."state" in ('pending', 'submitting', 'submitted', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "thumbstopper_jobs_cause_ck" CHECK ("thumbstopper_jobs"."cause_class" is null or "thumbstopper_jobs"."cause_class" in ('temporary', 'configuration', 'credit', 'provider_timeout', 'key_replaced', 'key_deleted', 'reference_unreachable', 'output_unreachable', 'outcome_unknown', 'cancelled_campaign_deleted', 'cancelled_account_suspended', 'cancelled_account_removed')),
	CONSTRAINT "thumbstopper_jobs_call_count_ck" CHECK ("thumbstopper_jobs"."call_count" >= 0),
	CONSTRAINT "thumbstopper_jobs_callout_ck" CHECK (char_length("thumbstopper_jobs"."callout_text") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "thumbstopper_jobs" ADD CONSTRAINT "thumbstopper_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbstopper_jobs" ADD CONSTRAINT "thumbstopper_jobs_output_media_id_media_objects_id_fk" FOREIGN KEY ("output_media_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thumbstopper_jobs_reuse_uq" ON "thumbstopper_jobs" USING btree ("owner_id","reuse_hash") WHERE "thumbstopper_jobs"."state" not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "thumbstopper_jobs_campaign_created_idx" ON "thumbstopper_jobs" USING btree ("campaign_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "thumbstopper_jobs_owner_state_idx" ON "thumbstopper_jobs" USING btree ("owner_id","state");--> statement-breakpoint
CREATE INDEX "thumbstopper_jobs_submitting_idx" ON "thumbstopper_jobs" USING btree ("submitting_at") WHERE "thumbstopper_jobs"."state" = 'submitting';--> statement-breakpoint
ALTER TABLE "assembly_jobs" ADD CONSTRAINT "assembly_jobs_thumbstopper_job_id_thumbstopper_jobs_id_fk" FOREIGN KEY ("thumbstopper_job_id") REFERENCES "public"."thumbstopper_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2). The api creates a thumbstopper job and cancels unfinished ones (campaign deletion, suspension);
-- the worker claims, calls the provider and settles it. Neither role deletes a row: they leave only through the campaign
-- cascade, which the owner role's lifecycle runs. app_backup reads every table by default privilege (M0001).
GRANT SELECT, INSERT, UPDATE ON "thumbstopper_jobs" TO app_api, app_worker;
