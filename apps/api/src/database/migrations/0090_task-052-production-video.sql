CREATE TABLE "qc_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"video_job_id" uuid NOT NULL,
	"qc_state" text DEFAULT 'pending' NOT NULL,
	"reason" varchar(300),
	"word_error_rate" numeric(4, 3),
	"state" text DEFAULT 'pending' NOT NULL,
	"cause_class" text,
	"cause_message" varchar(300),
	"reuse_hash" char(64) NOT NULL,
	"key_id" uuid,
	"key_version" integer,
	"call_count" smallint DEFAULT 0 NOT NULL,
	"submitting_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"provider_completed_at" timestamp with time zone,
	"provider_task_id" varchar(128),
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_runs_state_ck" CHECK ("qc_runs"."state" in ('pending', 'submitting', 'submitted', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "qc_runs_cause_ck" CHECK ("qc_runs"."cause_class" is null or "qc_runs"."cause_class" in ('temporary', 'configuration', 'credit', 'provider_timeout', 'key_replaced', 'key_deleted', 'reference_unreachable', 'output_unreachable', 'outcome_unknown', 'cancelled_campaign_deleted', 'cancelled_account_suspended', 'cancelled_account_removed')),
	CONSTRAINT "qc_runs_qc_state_ck" CHECK ("qc_runs"."qc_state" in ('pending', 'passed', 'failed', 'skipped')),
	CONSTRAINT "qc_runs_wer_ck" CHECK ("qc_runs"."word_error_rate" is null or "qc_runs"."word_error_rate" between 0 and 1),
	CONSTRAINT "qc_runs_call_count_ck" CHECK ("qc_runs"."call_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "video_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"segment_revision" integer NOT NULL,
	"reference_media_id" uuid,
	"provider_model" varchar(120) NOT NULL,
	"options" jsonb NOT NULL,
	"output_media_id" uuid,
	"provider_output_deleted_at" timestamp with time zone,
	"state" text DEFAULT 'pending' NOT NULL,
	"cause_class" text,
	"cause_message" varchar(300),
	"reuse_hash" char(64) NOT NULL,
	"key_id" uuid,
	"key_version" integer,
	"call_count" smallint DEFAULT 0 NOT NULL,
	"submitting_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"provider_completed_at" timestamp with time zone,
	"provider_task_id" varchar(128),
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_jobs_state_ck" CHECK ("video_jobs"."state" in ('pending', 'submitting', 'submitted', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "video_jobs_cause_ck" CHECK ("video_jobs"."cause_class" is null or "video_jobs"."cause_class" in ('temporary', 'configuration', 'credit', 'provider_timeout', 'key_replaced', 'key_deleted', 'reference_unreachable', 'output_unreachable', 'outcome_unknown', 'cancelled_campaign_deleted', 'cancelled_account_suspended', 'cancelled_account_removed')),
	CONSTRAINT "video_jobs_segment_revision_ck" CHECK ("video_jobs"."segment_revision" > 0),
	CONSTRAINT "video_jobs_call_count_ck" CHECK ("video_jobs"."call_count" >= 0),
	CONSTRAINT "video_jobs_options_ck" CHECK (jsonb_typeof("video_jobs"."options") = 'object' and "video_jobs"."options" - 'durationSeconds' - 'resolution' - 'aspectRatio' = '{}'::jsonb),
	CONSTRAINT "video_jobs_completed_ck" CHECK ("video_jobs"."provider_completed_at" is null or "video_jobs"."provider_task_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "qc_runs" ADD CONSTRAINT "qc_runs_video_job_id_video_jobs_id_fk" FOREIGN KEY ("video_job_id") REFERENCES "public"."video_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_segment_id_brief_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."brief_segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_reference_media_id_media_objects_id_fk" FOREIGN KEY ("reference_media_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_output_media_id_media_objects_id_fk" FOREIGN KEY ("output_media_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qc_runs_reuse_uq" ON "qc_runs" USING btree ("owner_id","reuse_hash") WHERE "qc_runs"."state" not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "qc_runs_job_created_idx" ON "qc_runs" USING btree ("video_job_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "qc_runs_owner_state_idx" ON "qc_runs" USING btree ("owner_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "video_jobs_reuse_uq" ON "video_jobs" USING btree ("owner_id","reuse_hash") WHERE "video_jobs"."state" not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "video_jobs_owner_state_idx" ON "video_jobs" USING btree ("owner_id","state");--> statement-breakpoint
CREATE INDEX "video_jobs_campaign_segment_idx" ON "video_jobs" USING btree ("campaign_id","segment_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "video_jobs_segment_idx" ON "video_jobs" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "video_jobs_poll_idx" ON "video_jobs" USING btree ("next_poll_at") WHERE "video_jobs"."state" in ('submitted', 'processing');--> statement-breakpoint
CREATE INDEX "video_jobs_submitting_idx" ON "video_jobs" USING btree ("submitting_at") WHERE "video_jobs"."state" = 'submitting';--> statement-breakpoint
CREATE INDEX "video_jobs_copy_idx" ON "video_jobs" USING btree ("provider_completed_at") WHERE "video_jobs"."state" = 'processing' and "video_jobs"."provider_completed_at" is not null;
--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2). The api creates video jobs and cancels unfinished ones (campaign deletion, suspension); the
-- worker submits, polls, copies and settles them and writes the QC runs. Neither role deletes a job or a QC run: they leave
-- only through the campaign cascade, which the owner role's lifecycle runs. app_backup reads every table by default
-- privilege (M0001).
GRANT SELECT, INSERT, UPDATE ON "video_jobs" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "qc_runs" TO app_api, app_worker;
