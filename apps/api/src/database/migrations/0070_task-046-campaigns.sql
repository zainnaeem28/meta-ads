CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"product_name" varchar(120) NOT NULL,
	"product_description" varchar(2000) NOT NULL,
	"product_media_id" uuid,
	"segment_count" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_state_ck" CHECK ("campaigns"."state" in ('active', 'deleting')),
	CONSTRAINT "campaigns_segment_count_ck" CHECK ("campaigns"."segment_count" between 1 and 4),
	CONSTRAINT "campaigns_product_name_ck" CHECK (length(btrim("campaigns"."product_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"step" smallint DEFAULT 1 NOT NULL,
	"ad_style" text DEFAULT 'ugc' NOT NULL,
	"intake_mode" text DEFAULT 'description' NOT NULL,
	"product_name" varchar(120),
	"product_description" varchar(2000),
	"audience_age_min" smallint,
	"audience_age_max" smallint,
	"audience_gender" text,
	"audience_interests" varchar(40)[],
	"direction_goal" text,
	"direction_tone" varchar(60),
	"segment_count" smallint,
	"concept" varchar(4000),
	"script" varchar(4000),
	"product_media_id" uuid,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_version_ck" CHECK ("drafts"."version" > 0),
	CONSTRAINT "drafts_step_ck" CHECK ("drafts"."step" between 1 and 5),
	CONSTRAINT "drafts_ad_style_ck" CHECK ("drafts"."ad_style" = 'ugc'),
	CONSTRAINT "drafts_intake_mode_ck" CHECK ("drafts"."intake_mode" in ('description', 'script')),
	CONSTRAINT "drafts_product_name_ck" CHECK ("drafts"."product_name" is null or length(btrim("drafts"."product_name")) > 0),
	CONSTRAINT "drafts_age_min_ck" CHECK ("drafts"."audience_age_min" is null or "drafts"."audience_age_min" between 21 and 99),
	CONSTRAINT "drafts_age_max_ck" CHECK ("drafts"."audience_age_max" is null or "drafts"."audience_age_max" between 21 and 99),
	CONSTRAINT "drafts_age_range_ck" CHECK ("drafts"."audience_age_min" is null or "drafts"."audience_age_max" is null or "drafts"."audience_age_max" >= "drafts"."audience_age_min"),
	CONSTRAINT "drafts_gender_ck" CHECK ("drafts"."audience_gender" is null or "drafts"."audience_gender" in ('all', 'female', 'male')),
	CONSTRAINT "drafts_interests_ck" CHECK ("drafts"."audience_interests" is null or cardinality("drafts"."audience_interests") <= 10),
	CONSTRAINT "drafts_goal_ck" CHECK ("drafts"."direction_goal" is null or "drafts"."direction_goal" in ('awareness', 'conversion', 'retention')),
	CONSTRAINT "drafts_segment_count_ck" CHECK ("drafts"."segment_count" is null or "drafts"."segment_count" between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_product_media_id_media_objects_id_fk" FOREIGN KEY ("product_media_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_product_media_id_media_objects_id_fk" FOREIGN KEY ("product_media_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_owner_active_idx" ON "campaigns" USING btree ("owner_id","updated_at" desc,"id" desc) WHERE "campaigns"."state" = 'active';--> statement-breakpoint
CREATE INDEX "campaigns_product_name_trgm_idx" ON "campaigns" USING gin ("product_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "campaigns_product_description_trgm_idx" ON "campaigns" USING gin ("product_description" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_product_media_uq" ON "campaigns" USING btree ("product_media_id") WHERE "campaigns"."product_media_id" is not null;--> statement-breakpoint
CREATE INDEX "drafts_owner_open_idx" ON "drafts" USING btree ("owner_id","updated_at" desc,"id" desc) WHERE "drafts"."campaign_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_campaign_uq" ON "drafts" USING btree ("campaign_id") WHERE "drafts"."campaign_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_product_media_uq" ON "drafts" USING btree ("product_media_id") WHERE "drafts"."product_media_id" is not null;
--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2). The api reads and writes drafts and campaigns; the worker reads campaigns for `isActive()`
-- and hard-deletes them (and, by cascade, their drafts) at the end of a deletion run. app_backup reads every table by
-- default privilege (M0001).
GRANT SELECT, INSERT, UPDATE, DELETE ON "drafts" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "campaigns" TO app_api, app_worker;
