CREATE TABLE "assembly_clips" (
	"assembly_job_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"video_job_id" uuid NOT NULL,
	"qc_override_confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "assembly_clips_assembly_job_id_position_pk" PRIMARY KEY("assembly_job_id","position"),
	CONSTRAINT "assembly_clips_position_ck" CHECK ("assembly_clips"."position" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "assembly_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"cause_class" text,
	"cause_message" varchar(300),
	"reuse_hash" char(64) NOT NULL,
	"thumbstopper_job_id" uuid,
	"output_media_id" uuid,
	"render_day" date NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assembly_jobs_state_ck" CHECK ("assembly_jobs"."state" in ('pending', 'queued', 'fetching', 'rendering', 'saving', 'done', 'failed')),
	CONSTRAINT "assembly_jobs_cause_ck" CHECK ("assembly_jobs"."cause_class" is null or "assembly_jobs"."cause_class" in ('render_failed', 'input_unavailable', 'timeout', 'cancelled_campaign_deleted', 'cancelled_account_suspended', 'cancelled_account_removed')),
	CONSTRAINT "assembly_jobs_attempts_ck" CHECK ("assembly_jobs"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "assembly_clips" ADD CONSTRAINT "assembly_clips_assembly_job_id_assembly_jobs_id_fk" FOREIGN KEY ("assembly_job_id") REFERENCES "public"."assembly_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_clips" ADD CONSTRAINT "assembly_clips_video_job_id_video_jobs_id_fk" FOREIGN KEY ("video_job_id") REFERENCES "public"."video_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_jobs" ADD CONSTRAINT "assembly_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_jobs" ADD CONSTRAINT "assembly_jobs_output_media_id_media_objects_id_fk" FOREIGN KEY ("output_media_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assembly_clips_video_job_idx" ON "assembly_clips" USING btree ("video_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assembly_jobs_reuse_uq" ON "assembly_jobs" USING btree ("campaign_id","reuse_hash") WHERE "assembly_jobs"."state" <> 'failed';--> statement-breakpoint
CREATE INDEX "assembly_jobs_owner_day_idx" ON "assembly_jobs" USING btree ("owner_id","render_day");--> statement-breakpoint
CREATE INDEX "assembly_jobs_campaign_idx" ON "assembly_jobs" USING btree ("campaign_id","created_at" desc);
--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2). The api creates an assembly with its clips (API-070) and cancels unfinished ones (campaign
-- deletion, suspension); the worker claims, renders and settles them. The clips are written once with their assembly.
-- Neither role deletes a row: they leave only through the campaign cascade, which the owner role's lifecycle runs.
-- app_backup reads every table by default privilege (M0001).
GRANT SELECT, INSERT, UPDATE ON "assembly_jobs" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON "assembly_clips" TO app_api, app_worker;
