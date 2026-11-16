CREATE TABLE "key_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"key_id" uuid,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_events_provider_ck" CHECK ("key_events"."provider" in ('openai', 'wavespeed')),
	CONSTRAINT "key_events_kind_ck" CHECK ("key_events"."kind" in ('added', 'replaced', 'deleted', 'test_passed', 'test_failed', 'stored_untested', 'validated_by_job', 'auth_failed', 'disabled', 'disabled_by_operator', 'attempt_rate_limited', 'rewrapped'))
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_version" smallint NOT NULL,
	"last4" char(4) NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"fingerprint_pepper_version" smallint NOT NULL,
	"consecutive_auth_failures" smallint DEFAULT 0 NOT NULL,
	"last_validated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_keys_provider_ck" CHECK ("provider_keys"."provider" in ('openai', 'wavespeed')),
	CONSTRAINT "provider_keys_status_ck" CHECK ("provider_keys"."status" in ('active', 'untested', 'disabled')),
	CONSTRAINT "provider_keys_version_ck" CHECK ("provider_keys"."version" > 0),
	CONSTRAINT "provider_keys_ciphertext_ck" CHECK (octet_length("provider_keys"."ciphertext") between 1 and 1024),
	CONSTRAINT "provider_keys_nonce_ck" CHECK (octet_length("provider_keys"."nonce") = 12),
	CONSTRAINT "provider_keys_wrapped_dek_ck" CHECK (octet_length("provider_keys"."wrapped_dek") = 384),
	CONSTRAINT "provider_keys_kek_version_ck" CHECK ("provider_keys"."kek_version" > 0),
	CONSTRAINT "provider_keys_fingerprint_ck" CHECK ("provider_keys"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "provider_keys_pepper_version_ck" CHECK ("provider_keys"."fingerprint_pepper_version" > 0),
	CONSTRAINT "provider_keys_failures_ck" CHECK ("provider_keys"."consecutive_auth_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "key_events_owner_at_idx" ON "key_events" USING btree ("owner_id","at" desc,"id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "provider_keys_owner_provider_uq" ON "provider_keys" USING btree ("owner_id","provider");--> statement-breakpoint
CREATE INDEX "provider_keys_kek_version_idx" ON "provider_keys" USING btree ("kek_version");
--> statement-breakpoint
-- Grants (ARCHITECTURE §2.2, ADR-009, TD-D7; SECURITY-DESIGN §9.4). app_api may write the sealed columns but can never read
-- them back: SELECT is limited to the non-secret columns, so a replacement is a conditional UPDATE that reads none of
-- ciphertext, nonce or wrapped_dek. app_worker reads everything (it unseals), inserts nothing, and deletes on erasure.
-- key_events is append-only history for both roles. app_backup reads every table by default privilege (M0001).
GRANT SELECT ("id", "owner_id", "provider", "status", "version", "kek_version", "last4", "fingerprint", "fingerprint_pepper_version", "consecutive_auth_failures", "last_validated_at", "disabled_at", "created_at", "updated_at"), INSERT, UPDATE, DELETE ON "provider_keys" TO app_api;--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON "provider_keys" TO app_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON "key_events" TO app_api, app_worker;
