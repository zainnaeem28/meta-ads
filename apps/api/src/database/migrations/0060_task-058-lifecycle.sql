CREATE TABLE "deletion_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"step" smallint DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"remaining_objects" integer,
	"last_error_class" varchar(64),
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_runs_kind_ck" CHECK ("deletion_runs"."kind" in ('campaign', 'account')),
	CONSTRAINT "deletion_runs_state_ck" CHECK ("deletion_runs"."state" in ('running', 'completed', 'stuck')),
	CONSTRAINT "deletion_runs_step_ck" CHECK (("deletion_runs"."kind" = 'campaign' and "deletion_runs"."step" between 1 and 4) or ("deletion_runs"."kind" = 'account' and "deletion_runs"."step" between 1 and 5)),
	CONSTRAINT "deletion_runs_attempts_ck" CHECK ("deletion_runs"."attempts" >= 0),
	CONSTRAINT "deletion_runs_remaining_ck" CHECK ("deletion_runs"."remaining_objects" is null or "deletion_runs"."remaining_objects" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_runs_subject_uq" ON "deletion_runs" USING btree ("kind","subject_id");
--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2). The api inserts a run in the transaction that hides the campaign and reads it; the worker
-- advances it. Neither role deletes a run: it stays as the record that the deletion happened (IDs only). app_backup reads
-- every table by default privilege (M0001).
GRANT SELECT, INSERT ON "deletion_runs" TO app_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "deletion_runs" TO app_worker;
