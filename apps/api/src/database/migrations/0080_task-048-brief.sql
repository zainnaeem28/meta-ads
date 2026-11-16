CREATE TABLE "brand_rules" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"class" text NOT NULL,
	"clearable" boolean NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"message" varchar(300) NOT NULL,
	"rules_version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "brand_rules_class_ck" CHECK ("brand_rules"."class" in ('high_risk', 'other')),
	CONSTRAINT "brand_rules_clearable_ck" CHECK ("brand_rules"."class" <> 'high_risk' or "brand_rules"."clearable" = false),
	CONSTRAINT "brand_rules_kind_ck" CHECK ("brand_rules"."kind" in ('phrase', 'regex', 'word_count_min', 'word_count_max_target', 'cta_exact', 'em_dash', 'age_framing')),
	CONSTRAINT "brand_rules_version_ck" CHECK ("brand_rules"."rules_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "brief_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"campaign_id" uuid,
	"media_id" uuid,
	"generation_seq" integer DEFAULT 0 NOT NULL,
	"result_text" varchar(1500),
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
	CONSTRAINT "brief_jobs_kind_ck" CHECK ("brief_jobs"."kind" in ('brief_generation', 'image_analysis')),
	CONSTRAINT "brief_jobs_parent_ck" CHECK (("brief_jobs"."kind" = 'brief_generation' and "brief_jobs"."campaign_id" is not null) or ("brief_jobs"."kind" = 'image_analysis' and "brief_jobs"."media_id" is not null)),
	CONSTRAINT "brief_jobs_state_ck" CHECK ("brief_jobs"."state" in ('pending', 'submitting', 'submitted', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "brief_jobs_cause_ck" CHECK ("brief_jobs"."cause_class" is null or "brief_jobs"."cause_class" in ('temporary', 'configuration', 'credit', 'provider_timeout', 'key_replaced', 'key_deleted', 'reference_unreachable', 'output_unreachable', 'outcome_unknown', 'cancelled_campaign_deleted', 'cancelled_account_suspended', 'cancelled_account_removed')),
	CONSTRAINT "brief_jobs_generation_seq_ck" CHECK ("brief_jobs"."generation_seq" >= 0),
	CONSTRAINT "brief_jobs_call_count_ck" CHECK ("brief_jobs"."call_count" >= 0),
	CONSTRAINT "brief_jobs_completed_ck" CHECK ("brief_jobs"."provider_completed_at" is null or "brief_jobs"."provider_task_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "brief_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brief_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"dialogue" varchar(600) DEFAULT '' NOT NULL,
	"prompt" varchar(2000) DEFAULT '' NOT NULL,
	"word_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brief_segments_position_ck" CHECK ("brief_segments"."position" between 1 and 4),
	CONSTRAINT "brief_segments_state_ck" CHECK ("brief_segments"."state" in ('active', 'retired')),
	CONSTRAINT "brief_segments_revision_ck" CHECK ("brief_segments"."revision" > 0),
	CONSTRAINT "brief_segments_word_count_ck" CHECK ("brief_segments"."word_count" between 0 and 120)
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"state" text DEFAULT 'generating' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"generation_seq" integer DEFAULT 1 NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefs_state_ck" CHECK ("briefs"."state" in ('generating', 'draft', 'accepted', 'failed')),
	CONSTRAINT "briefs_version_ck" CHECK ("briefs"."version" > 0),
	CONSTRAINT "briefs_generation_seq_ck" CHECK ("briefs"."generation_seq" > 0),
	CONSTRAINT "briefs_accepted_ck" CHECK (("briefs"."state" = 'accepted') = ("briefs"."accepted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "claim_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"brief_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"class" text NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_events_class_ck" CHECK ("claim_events"."class" in ('high_risk', 'other')),
	CONSTRAINT "claim_events_outcome_ck" CHECK ("claim_events"."outcome" in ('raised', 'closed_by_edit', 'cleared_with_reason'))
);
--> statement-breakpoint
CREATE TABLE "claim_issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"brief_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"field" text NOT NULL,
	"rule_id" varchar(64) NOT NULL,
	"class" text NOT NULL,
	"resolution" text DEFAULT 'open' NOT NULL,
	"message" varchar(300) NOT NULL,
	"span_start" integer,
	"span_end" integer,
	"cleared_by" uuid,
	"clear_reason" varchar(500),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_issues_field_ck" CHECK ("claim_issues"."field" in ('dialogue', 'prompt')),
	CONSTRAINT "claim_issues_class_ck" CHECK ("claim_issues"."class" in ('high_risk', 'other')),
	CONSTRAINT "claim_issues_resolution_ck" CHECK ("claim_issues"."resolution" in ('open', 'closed_by_edit', 'cleared_with_reason')),
	CONSTRAINT "claim_issues_clear_ck" CHECK ("claim_issues"."resolution" <> 'cleared_with_reason' or ("claim_issues"."class" = 'other' and "claim_issues"."clear_reason" is not null)),
	CONSTRAINT "claim_issues_span_ck" CHECK (("claim_issues"."span_start" is null and "claim_issues"."span_end" is null) or ("claim_issues"."span_start" >= 0 and "claim_issues"."span_end" is not null and "claim_issues"."span_end" >= "claim_issues"."span_start"))
);
--> statement-breakpoint
ALTER TABLE "brief_jobs" ADD CONSTRAINT "brief_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_jobs" ADD CONSTRAINT "brief_jobs_media_id_media_objects_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_segments" ADD CONSTRAINT "brief_segments_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_issues" ADD CONSTRAINT "claim_issues_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_issues" ADD CONSTRAINT "claim_issues_segment_id_brief_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."brief_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brief_jobs_reuse_uq" ON "brief_jobs" USING btree ("owner_id","reuse_hash") WHERE "brief_jobs"."state" not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "brief_jobs_owner_state_idx" ON "brief_jobs" USING btree ("owner_id","state");--> statement-breakpoint
CREATE INDEX "brief_jobs_poll_idx" ON "brief_jobs" USING btree ("next_poll_at") WHERE "brief_jobs"."state" in ('submitted', 'processing');--> statement-breakpoint
CREATE INDEX "brief_jobs_submitting_idx" ON "brief_jobs" USING btree ("submitting_at") WHERE "brief_jobs"."state" = 'submitting';--> statement-breakpoint
CREATE INDEX "brief_jobs_copy_idx" ON "brief_jobs" USING btree ("provider_completed_at") WHERE "brief_jobs"."state" = 'processing' and "brief_jobs"."provider_completed_at" is not null;--> statement-breakpoint
CREATE INDEX "brief_jobs_campaign_idx" ON "brief_jobs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "brief_jobs_media_idx" ON "brief_jobs" USING btree ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_segments_position_uq" ON "brief_segments" USING btree ("brief_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "briefs_campaign_uq" ON "briefs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "claim_events_at_idx" ON "claim_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "claim_issues_open_idx" ON "claim_issues" USING btree ("brief_id") WHERE "claim_issues"."resolution" = 'open';--> statement-breakpoint
CREATE INDEX "claim_issues_segment_idx" ON "claim_issues" USING btree ("segment_id");
--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2). The api writes briefs, segments and issues on edit, accept and clear; the worker writes them
-- when a generation lands, and both create and settle brief jobs. Claim events are append-only history: both roles read
-- and insert, none updates or deletes. The rule set is configuration loaded by the release seed (owner role): the runtime
-- roles only read it. app_backup reads every table by default privilege (M0001).
GRANT SELECT, INSERT, UPDATE, DELETE ON "brief_jobs" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "briefs" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "brief_segments" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "claim_issues" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON "claim_events" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT ON "brand_rules" TO app_api, app_worker;
