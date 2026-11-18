-- Database roles and grants (DO-11, TASK-018; DEVOPS-PLAN 10.2, 17 DO-11; SB v6 7.1 B). Idempotent: run it any number of times.
-- Run ONCE per environment by the owner as the host's admin role (CREATEROLE, not superuser), after the database exists and
-- before the first migration (M0001 refuses to run when a role is missing or has the wrong attributes). Use roles.sh.
--
-- Inputs (psql variables, set by roles.sh from the environment; a password is never printed):
--   app_db                         the application database (default shroomap)
--   r_migrator r_api r_worker r_backup   role names (defaults app_migrator app_api app_worker app_backup)
--   pw_migrator pw_api pw_worker pw_backup   passwords, used only when the role is created or rotate = 1
--   rotate                         1 sets the passwords of existing roles too (two-step rotation, docs/ops/secret-rotation.md)
--
-- The creating admin's automatic membership in each role (PostgreSQL 16+: ADMIN OPTION, INHERIT FALSE, SET FALSE, SB-D25)
-- is neither granted nor revoked here, and no role is made a member of another.
\set ON_ERROR_STOP on
\if :{?app_db} \else \set app_db shroomap \endif
\if :{?r_migrator} \else \set r_migrator app_migrator \endif
\if :{?r_api} \else \set r_api app_api \endif
\if :{?r_worker} \else \set r_worker app_worker \endif
\if :{?r_backup} \else \set r_backup app_backup \endif
\if :{?rotate} \else \set rotate 0 \endif
\getenv pw_migrator PROVISION_PW_MIGRATOR
\getenv pw_api PROVISION_PW_API
\getenv pw_worker PROVISION_PW_WORKER
\getenv pw_backup PROVISION_PW_BACKUP

-- Hand the values to the DO block as session settings (a DO block cannot read psql variables).
SELECT set_config('provision.app_db', :'app_db', false),
       set_config('provision.rotate', :'rotate', false),
       set_config('provision.r_migrator', :'r_migrator', false), set_config('provision.r_api', :'r_api', false),
       set_config('provision.r_worker', :'r_worker', false), set_config('provision.r_backup', :'r_backup', false),
       set_config('provision.pw_migrator', coalesce(:'pw_migrator', ''), false), set_config('provision.pw_api', coalesce(:'pw_api', ''), false),
       set_config('provision.pw_worker', coalesce(:'pw_worker', ''), false), set_config('provision.pw_backup', coalesce(:'pw_backup', ''), false) \gset ignore_

DO $provision$
DECLARE
  roles text[][] := ARRAY[['migrator', current_setting('provision.r_migrator')], ['api', current_setting('provision.r_api')],
                          ['worker', current_setting('provision.r_worker')], ['backup', current_setting('provision.r_backup')]];
  app_db text := current_setting('provision.app_db');
  rotate boolean := current_setting('provision.rotate') = '1';
  k text; r text; pw text; attrs text; exists_already boolean; d record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = app_db) THEN
    RAISE EXCEPTION 'database % does not exist: create it first (render.yaml databases)', app_db;
  END IF;
  -- Refuse before creating anything when a role to be created has no password.
  FOR i IN 1 .. array_length(roles, 1) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = roles[i][2]) AND current_setting('provision.pw_' || roles[i][1]) = '' THEN
      RAISE EXCEPTION 'role % does not exist and PROVISION_PW_% is not set', roles[i][2], upper(roles[i][1]);
    END IF;
  END LOOP;
  FOR i IN 1 .. array_length(roles, 1) LOOP
    k := roles[i][1]; r := roles[i][2]; pw := current_setting('provision.pw_' || k);
    attrs := 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';  -- CREATE only; see the ALTER branch
    attrs := attrs || CASE WHEN k = 'backup' THEN ' NOINHERIT CONNECTION LIMIT 2' ELSE '' END;
    exists_already := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    IF NOT exists_already THEN
      IF pw = '' THEN RAISE EXCEPTION 'role % does not exist and PROVISION_PW_% is not set', r, upper(k); END IF;
      EXECUTE format('CREATE ROLE %I %s PASSWORD %L', r, attrs, pw);
      RAISE NOTICE 'created role %', r;
    ELSE
      -- A non-superuser admin may not name SUPERUSER, CREATEDB, REPLICATION or BYPASSRLS in ALTER ROLE, so an elevated role is
      -- refused, not repaired. What it may change (LOGIN, INHERIT, the connection limit) it sets.
      PERFORM 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
      IF FOUND THEN RAISE EXCEPTION 'role % has an elevated attribute (SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS): resolve it by hand', r; END IF;
      EXECUTE format('ALTER ROLE %I LOGIN %s', r, CASE WHEN k = 'backup' THEN 'NOINHERIT CONNECTION LIMIT 2' ELSE 'INHERIT' END);
      IF rotate AND pw <> '' THEN EXECUTE format('ALTER ROLE %I PASSWORD %L', r, pw); RAISE NOTICE 'rotated password of %', r; END IF;
    END IF;
    -- Session defaults M0001 checks and relies on: the backup role can never write, the others resolve names in public.
    IF k = 'backup' THEN
      EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', r);
    ELSE
      EXECUTE format('ALTER ROLE %I SET search_path = public', r);
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', app_db, r);
  END LOOP;

  -- No other database may be reachable through PUBLIC's default CONNECT (SB v6 7.1 B). Where the host does not let the admin
  -- change a database it does not own, say so: that is recorded in the read-back, never silently accepted.
  FOR d IN SELECT datname FROM pg_database WHERE datname <> app_db AND datallowconn ORDER BY datname LOOP
    BEGIN
      EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', d.datname);
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- decided by the check below
    END;
    -- A REVOKE by a non-owner only warns, so read the result instead of trusting the statement.
    IF has_database_privilege('public', d.datname, 'CONNECT') THEN
      RAISE NOTICE 'CANNOT REVOKE CONNECT FROM PUBLIC on database % (host does not allow it; recorded)', d.datname;
    END IF;
  END LOOP;
END
$provision$;
