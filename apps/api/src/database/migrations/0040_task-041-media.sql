CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"storage_key" varchar(300) NOT NULL,
	"bytes" bigint,
	"content_type" varchar(32),
	"width" integer,
	"height" integer,
	"campaign_id" uuid,
	"attached_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_objects_kind_ck" CHECK ("media_objects"."kind" in ('upload', 'clip', 'final', 'thumbstopper')),
	CONSTRAINT "media_objects_state_ck" CHECK ("media_objects"."state" in ('processing', 'ready', 'rejected')),
	CONSTRAINT "media_objects_reject_ck" CHECK (("media_objects"."state" = 'rejected') = ("media_objects"."reject_reason" is not null)),
	CONSTRAINT "media_objects_reject_reason_ck" CHECK ("media_objects"."reject_reason" in ('type_not_allowed', 'pixel_cap_exceeded', 'decompression_bomb', 'decode_failed')),
	CONSTRAINT "media_objects_bytes_ck" CHECK ("media_objects"."bytes" >= 0),
	CONSTRAINT "media_objects_content_type_ck" CHECK ("media_objects"."content_type" in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4')),
	CONSTRAINT "media_objects_width_ck" CHECK ("media_objects"."width" > 0),
	CONSTRAINT "media_objects_height_ck" CHECK ("media_objects"."height" > 0)
);
--> statement-breakpoint
CREATE TABLE "storage_usage" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"bytes_used" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "storage_usage_bytes_ck" CHECK ("storage_usage"."bytes_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_objects_storage_key_uq" ON "media_objects" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_objects_owner_created_idx" ON "media_objects" USING btree ("owner_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "media_objects_campaign_idx" ON "media_objects" USING btree ("campaign_id") WHERE "media_objects"."campaign_id" is not null;--> statement-breakpoint
CREATE INDEX "media_objects_unattached_idx" ON "media_objects" USING btree ("created_at") WHERE "media_objects"."kind" = 'upload' and "media_objects"."attached_at" is null;
--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2). Both runtime roles read and write the two media tables: the api inserts uploads and moves
-- quota in the same transaction, the worker settles `processing` rows, deletes swept and erased ones and registers outputs.
-- app_backup reads every table by default privilege (M0001).
GRANT SELECT, INSERT, UPDATE, DELETE ON "media_objects" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_usage" TO app_api, app_worker;
