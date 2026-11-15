-- M0001 platform (TASK-025, ARCHITECTURE §2.7, SB v6 §7.1 B). Runs as app_migrator.
-- Roles are created at provisioning (DO-05, DO-11), never here; this migration fails closed when one is missing.
DO $$
DECLARE
  missing text;
  bad text;
BEGIN
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing
    FROM (VALUES ('app_migrator'), ('app_api'), ('app_worker'), ('app_backup')) AS r(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'M0001 refused: required database role(s) missing: %. Create them at provisioning (DO-11) first.', missing;
  END IF;
  IF current_user <> 'app_migrator' THEN
    RAISE EXCEPTION 'M0001 refused: must run as app_migrator, not %', current_user;
  END IF;
  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles
   WHERE rolname = 'app_backup'
     AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls
          OR NOT rolcanlogin OR rolconnlimit <> 2);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'M0001 refused: app_backup attributes differ from SB v6 section 7.1 B (LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.member
     WHERE am.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'app_backup') AND (am.inherit_option OR am.set_option)
  ) OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname <> 'app_backup' AND pg_has_role('app_backup', r.oid, 'MEMBER')) THEN
    RAISE EXCEPTION 'M0001 refused: app_backup is a member of another role, or a member may inherit or SET ROLE to it';
  END IF;
  -- Session defaults are set by the host admin at provisioning (ALTER ROLE ... SET), so they are checked, not issued.
  IF NOT EXISTS (
    SELECT 1 FROM pg_db_role_setting s
     WHERE s.setdatabase = 0 AND s.setrole = (SELECT oid FROM pg_roles WHERE rolname = 'app_backup')
       AND 'default_transaction_read_only=on' = ANY (s.setconfig)
  ) THEN
    RAISE EXCEPTION 'M0001 refused: app_backup has no default_transaction_read_only = on session default (ALTER ROLE app_backup SET default_transaction_read_only = on)';
  END IF;
  SELECT string_agg(r.name, ', ') INTO bad
    FROM (VALUES ('app_migrator'), ('app_api'), ('app_worker')) AS r(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) AS c
      WHERE s.setdatabase = 0 AND s.setrole = (SELECT oid FROM pg_roles WHERE rolname = r.name)
        AND c LIKE 'search_path=%' AND c LIKE '%public%'
   );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'M0001 refused: no search_path = public session default for role(s): % (set at provisioning)', bad;
  END IF;
END
$$;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- pg-boss schema, owned by app_migrator; pg-boss DDL and createQueue run only in jobs:migrate (SB-D24).
CREATE SCHEMA IF NOT EXISTS pgboss;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_api, app_worker, app_backup;--> statement-breakpoint
GRANT USAGE ON SCHEMA pgboss TO app_api, app_worker, app_backup;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api, app_worker;--> statement-breakpoint
-- app_backup reads every table and sequence of public and pgboss, existing and future (objects of app_migrator only).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_backup;--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO app_backup;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO app_backup;--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO app_backup;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public GRANT SELECT ON TABLES TO app_backup;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO app_backup;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA pgboss GRANT SELECT ON TABLES TO app_backup;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA pgboss GRANT SELECT ON SEQUENCES TO app_backup;--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"owner_id" uuid NOT NULL,
	"operation_id" varchar(16) NOT NULL,
	"key" varchar(128) NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"resource_type" varchar(32) NOT NULL,
	"resource_id" uuid NOT NULL,
	"response_status" smallint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_records_owner_id_operation_id_key_pk" PRIMARY KEY("owner_id","operation_id","key"),
	CONSTRAINT "idempotency_records_hash_len_ck" CHECK (octet_length("idempotency_records"."request_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"scope" varchar(48) NOT NULL,
	"subject" varchar(64) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limit_buckets_scope_subject_window_start_pk" PRIMARY KEY("scope","subject","window_start")
);
--> statement-breakpoint
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("expires_at");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_buckets" TO app_api, app_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_records" TO app_api, app_worker;
