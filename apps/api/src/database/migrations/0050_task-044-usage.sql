CREATE TABLE "price_table" (
	"provider" text NOT NULL,
	"operation" varchar(64) NOT NULL,
	"effective_from" date NOT NULL,
	"unit" varchar(32) NOT NULL,
	"unit_price_usd" numeric(12, 6) NOT NULL,
	"units_per_call" numeric(10, 3) NOT NULL,
	CONSTRAINT "price_table_provider_operation_effective_from_pk" PRIMARY KEY("provider","operation","effective_from"),
	CONSTRAINT "price_table_provider_ck" CHECK ("price_table"."provider" in ('openai', 'wavespeed', 'assembly_vendor')),
	CONSTRAINT "price_table_price_ck" CHECK ("price_table"."unit_price_usd" >= 0),
	CONSTRAINT "price_table_units_ck" CHECK ("price_table"."units_per_call" >= 0)
);
--> statement-breakpoint
CREATE TABLE "spend_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"job_id" uuid NOT NULL,
	"estimated_cost_usd" numeric(12, 4) NOT NULL,
	"remaining_calls" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_reservations_job_uq" UNIQUE("job_type","job_id"),
	CONSTRAINT "spend_reservations_job_type_ck" CHECK ("spend_reservations"."job_type" in ('brief_generation', 'image_analysis', 'video', 'qc', 'thumbstopper', 'assembly')),
	CONSTRAINT "spend_reservations_cost_ck" CHECK ("spend_reservations"."estimated_cost_usd" >= 0),
	CONSTRAINT "spend_reservations_calls_ck" CHECK ("spend_reservations"."remaining_calls" >= 1)
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"operation" varchar(64) NOT NULL,
	"job_type" text NOT NULL,
	"job_id" uuid NOT NULL,
	"call_seq" smallint NOT NULL,
	"outcome" text NOT NULL,
	"estimated_cost_usd" numeric(12, 4) NOT NULL,
	"cost_basis" text NOT NULL,
	"latency_ms" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_call_uq" UNIQUE("job_type","job_id","call_seq"),
	CONSTRAINT "usage_events_provider_ck" CHECK ("usage_events"."provider" in ('openai', 'wavespeed', 'assembly_vendor')),
	CONSTRAINT "usage_events_job_type_ck" CHECK ("usage_events"."job_type" in ('brief_generation', 'image_analysis', 'video', 'qc', 'thumbstopper', 'assembly')),
	CONSTRAINT "usage_events_call_seq_ck" CHECK ("usage_events"."call_seq" >= 1),
	CONSTRAINT "usage_events_outcome_ck" CHECK ("usage_events"."outcome" in ('succeeded', 'failed', 'rejected', 'unconfirmed')),
	CONSTRAINT "usage_events_cost_basis_ck" CHECK ("usage_events"."cost_basis" in ('estimate', 'zero_rejected', 'unconfirmed_estimate')),
	CONSTRAINT "usage_events_cost_ck" CHECK ("usage_events"."estimated_cost_usd" >= 0),
	CONSTRAINT "usage_events_latency_ck" CHECK ("usage_events"."latency_ms" >= 0),
	CONSTRAINT "usage_events_basis_outcome_ck" CHECK (("usage_events"."outcome" = 'rejected') = ("usage_events"."cost_basis" = 'zero_rejected')
        and ("usage_events"."outcome" = 'unconfirmed') = ("usage_events"."cost_basis" = 'unconfirmed_estimate')
        and ("usage_events"."cost_basis" <> 'zero_rejected' or "usage_events"."estimated_cost_usd" = 0))
);
--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_reservations_owner_idx" ON "spend_reservations" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "usage_events_owner_at_idx" ON "usage_events" USING btree ("owner_id","at");--> statement-breakpoint
CREATE INDEX "usage_events_at_idx" ON "usage_events" USING btree ("at");--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2). `usage_events` is append-only history: both roles read and insert, none updates or deletes.
-- Reservations are inserted by the api at job creation and settled by the worker, so both roles write them. The price
-- table is configuration loaded by the release seed (owner role): the runtime roles only read it.
-- app_backup reads every table by default privilege (M0001).
GRANT SELECT, INSERT ON "usage_events" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "spend_reservations" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT ON "price_table" TO app_api, app_worker;
