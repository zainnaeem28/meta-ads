-- Read-back of the roles, grants and connection capacity (DO-11, TASK-018). Read-only; run it as the host admin after
-- roles.sql, and again any time. Prints `ok`/`FAIL` lines and exits non-zero (ON_ERROR_STOP) on the first failure.
--   psql variables: app_db, r_migrator, r_api, r_worker, r_backup (defaults as roles.sql),
--                   peak (connection peak to cover, default 47), headroom_percent (default 80)
\set ON_ERROR_STOP on
\if :{?app_db} \else \set app_db shroomap \endif
\if :{?r_migrator} \else \set r_migrator app_migrator \endif
\if :{?r_api} \else \set r_api app_api \endif
\if :{?r_worker} \else \set r_worker app_worker \endif
\if :{?r_backup} \else \set r_backup app_backup \endif
\if :{?peak} \else \set peak 47 \endif
\if :{?headroom_percent} \else \set headroom_percent 80 \endif
\pset tuples_only on
\pset format unaligned
SELECT set_config('provision.app_db', :'app_db', false), set_config('provision.r_migrator', :'r_migrator', false),
       set_config('provision.r_api', :'r_api', false), set_config('provision.r_worker', :'r_worker', false),
       set_config('provision.r_backup', :'r_backup', false), set_config('provision.peak', :'peak', false),
       set_config('provision.headroom', :'headroom_percent', false) \gset ignore_

DO $verify$
DECLARE
  app_db text := current_setting('provision.app_db');
  backup text := current_setting('provision.r_backup');
  r text; n int; bad text; maxc int; peak int := current_setting('provision.peak')::int;
  pct int := current_setting('provision.headroom')::int;
BEGIN
  FOREACH r IN ARRAY ARRAY[current_setting('provision.r_migrator'), current_setting('provision.r_api'), current_setting('provision.r_worker'), backup] LOOP
    PERFORM 1 FROM pg_roles WHERE rolname = r AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL role % missing or has an elevated attribute', r; END IF;
    IF NOT has_database_privilege(r, app_db, 'CONNECT') THEN RAISE EXCEPTION 'FAIL % cannot CONNECT to %', r, app_db; END IF;
    RAISE NOTICE 'ok role % exists, login, no elevated attribute, CONNECT on %', r, app_db;
  END LOOP;

  -- app_backup (SB v6 7.1 B): connection limit 2, NOINHERIT, read-only session default, member of no role it may inherit or SET.
  PERFORM 1 FROM pg_roles WHERE rolname = backup AND rolconnlimit = 2 AND NOT rolinherit;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL % must be NOINHERIT with CONNECTION LIMIT 2', backup; END IF;
  PERFORM 1 FROM pg_db_role_setting s WHERE s.setdatabase = 0 AND s.setrole = (SELECT oid FROM pg_roles WHERE rolname = backup)
     AND 'default_transaction_read_only=on' = ANY (s.setconfig);
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL % has no default_transaction_read_only = on', backup; END IF;
  SELECT count(*) INTO n FROM pg_auth_members am WHERE am.member = (SELECT oid FROM pg_roles WHERE rolname = backup);
  IF n > 0 THEN RAISE EXCEPTION 'FAIL % is a member of % role(s)', backup, n; END IF;
  SELECT string_agg(g.rolname, ', ') INTO bad FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.member
   WHERE am.roleid = (SELECT oid FROM pg_roles WHERE rolname = backup) AND (am.inherit_option OR am.set_option);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL % can be inherited or SET by %', backup, bad; END IF;
  RAISE NOTICE 'ok % connection limit 2, NOINHERIT, read-only default, member of no role, no member inherits or SETs it', backup;
  SELECT string_agg(r2, ', ') INTO bad FROM unnest(ARRAY[current_setting('provision.r_migrator'), current_setting('provision.r_api'), current_setting('provision.r_worker')]) r2
   WHERE NOT EXISTS (SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) c WHERE s.setdatabase = 0
     AND s.setrole = (SELECT oid FROM pg_roles WHERE rolname = r2) AND c LIKE 'search_path=%' AND c LIKE '%public%');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL no search_path = public default for %', bad; END IF;
  RAISE NOTICE 'ok runtime and migrator roles default search_path to public';

  -- PUBLIC CONNECT on other databases: ok where revoked, recorded (not failed) where the host does not allow the revoke.
  FOR r IN SELECT datname FROM pg_database WHERE datname <> app_db AND datallowconn ORDER BY datname LOOP
    IF has_database_privilege('public', r, 'CONNECT') THEN
      RAISE NOTICE 'RECORDED database % still allows CONNECT through PUBLIC (host does not let the admin revoke it)', r;
    ELSE
      RAISE NOTICE 'ok database % does not allow CONNECT through PUBLIC', r;
    END IF;
  END LOOP;

  maxc := current_setting('max_connections')::int;
  IF peak * 100 > maxc * pct THEN
    RAISE EXCEPTION 'FAIL max_connections % cannot hold the % connection peak within % percent (shrink the pools before G3: api 5+2, worker 4+4)', maxc, peak, pct;
  END IF;
  RAISE NOTICE 'ok max_connections = % covers the % connection peak within % percent (limit %)', maxc, peak, pct, maxc * pct / 100;
END
$verify$;
