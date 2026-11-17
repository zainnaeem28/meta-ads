#!/usr/bin/env bash
# Runs the steps of RUN-GUIDE.md on a machine that has no Docker and may not start its own PostgreSQL: the shared test
# PostgreSQL stands in for the compose one. The differences from the guide, all forced by the shared server, are:
#   - role names and the database carry a run suffix (the server holds other runs' app_* roles); the SQL is the guide's own,
#     extracted from RUN-GUIDE.md and renamed, and migration 0001's role names are renamed the same way in a copy;
#   - the three processes listen on other ports (4010, 3010) because 4000 and 3000 may be taken;
#   - psql connects to the shared server instead of `docker compose exec`.
# Usage: CI=1 docs/evidence/TASK-017/run-guide.sh 2>&1 | sed "s#$PWD#<repo>#g" > docs/evidence/TASK-017/guide-run.txt
# (the sed hides the checkout path: a branch name inside it looks like an API key to the secret scanner)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
ROOT="$PWD"
ADMIN="${TEST_DATABASE_ADMIN_URL:-postgres://postgres@test-db:5432/postgres}"
HOSTPORT="$(echo "$ADMIN" | sed -E 's#.*@([^/]+)/.*#\1#')"
SUF="g$(date +%s | tail -c 6)"
WORK="$(mktemp -d)"
PIDS=()
unset DATABASE_URL
step() { printf '\n=== %s\n' "$*"; }
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  psql -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS shroomap_$SUF" >/dev/null 2>&1
  for r in migrator api worker backup; do psql -X -q "$ADMIN" -c "DROP ROLE IF EXISTS app_${r}_$SUF" >/dev/null 2>&1; done
  rm -rf "$WORK"
  printf '\n=== cleanup: processes stopped, database shroomap_%s and the four app_*_%s roles dropped\n' "$SUF" "$SUF"
}
trap cleanup EXIT
fail=0
run() { printf '$ %s\n' "$*"; "$@"; local rc=$?; [ $rc -eq 0 ] || { printf '!! exit %s\n' $rc; fail=1; }; return 0; }

step "environment"
echo "node $(node -v), pnpm $(pnpm -v), psql $(psql --version | awk '{print $3}'), run suffix $SUF, commit $(git rev-parse --short HEAD)"
echo "docker: $(command -v docker >/dev/null && echo present || echo absent) (the compose stack of step 3 is not started here)"

step "1. clone and install (guide section 1; the clone itself is this checkout)"
run pnpm install --frozen-lockfile

step "2. local configuration"
run node scripts/ci/config-consistency.mjs --local-env .env.local.d

step "4. provision the database roles: the guide's SQL, renamed with the run suffix"
python3 - "$SUF" "$WORK" <<'PY'
import re, sys
suf, work = sys.argv[1:3]
guide = open("RUN-GUIDE.md").read()
sec = re.search(r"^## 4\..*?(?=^## )", guide, re.S | re.M).group(0)
sql = re.search(r"<<'SQL'\n(.*?)\nSQL\n", sec, re.S).group(1)
sql = re.sub(r"\bapp_(migrator|api|worker|backup)\b", lambda m: f"app_{m.group(1)}_{suf}", sql).replace("shroomap_dev", f"shroomap_{suf}")
open(f"{work}/provision.sql", "w").write(sql + "\n")
schema = re.search(r"-c 'ALTER SCHEMA public OWNER TO app_migrator'", sec)
assert schema, "the guide's ALTER SCHEMA command is missing"
open(f"{work}/schema.sql", "w").write(f"ALTER SCHEMA public OWNER TO app_migrator_{suf}\n")
PY
psql -X -q -v ON_ERROR_STOP=1 "$ADMIN" -c "CREATE DATABASE shroomap_$SUF"   # the compose PostgreSQL has this database already
run psql -X -v ON_ERROR_STOP=1 "$ADMIN" -f "$WORK/provision.sql"
run psql -X -v ON_ERROR_STOP=1 "$(echo "$ADMIN" | sed -E "s#/[^/]*\$#/shroomap_$SUF#")" -f "$WORK/schema.sql"

U() { echo "postgres://app_$1_$SUF:shroomap-local@$HOSTPORT/shroomap_$SUF"; }
echo "DATABASE_URL=$(U api)"      > .env.local.d/db-api.env
echo "DATABASE_URL=$(U worker)"   > .env.local.d/db-worker.env
echo "MIGRATION_DATABASE_URL=$(U migrator)" > .env.local.d/db-release.env
echo "BACKUP_DATABASE_URL=$(U backup)"      > .env.local.d/db-backup.env
echo "API_PORT=4010" >> .env.local.d/db-api.env
echo "(the four override files of the guide were written with these role names; API_PORT=4010 added)"

step "5. build"
( set -a; . .env.local.d/web.env; set +a; run pnpm build ) 2>&1 | tail -8

step "6. migrate (the guide's command, with migration 0001's role names renamed in a copy for the shared server)"
mkdir -p "$WORK/r"; cp -r apps/api/src/database/migrations "$WORK/r/migrations"
sed -i -E "s/\bapp_(migrator|api|worker|backup)\b/app_\1_$SUF/g" "$WORK"/r/migrations/*.sql
echo "export default { dialect: 'postgresql', out: './migrations', dbCredentials: { url: process.env.MIGRATION_DATABASE_URL } };" > "$WORK/r/drizzle.config.ts"
echo '$ CI=1 drizzle-kit migrate (the command behind `pnpm --filter @shroomap/api db:migrate`, config pointing at the renamed copy)'
( cd "$WORK/r" && set -a && . "$ROOT/.env.local.d/db-release.env" && set +a && CI=1 "$ROOT/apps/api/node_modules/.bin/drizzle-kit" migrate --config "$WORK/r/drizzle.config.ts" 2>&1 | tr '\r' '\n' | tail -2 )
echo "applied migrations: $(psql -X -At "$(U migrator)" -c 'select count(*) from drizzle.__drizzle_migrations') of $(ls apps/api/src/database/migrations/*.sql | wc -l)"
cd apps/api
E="--env-file=../../.env.local.d/release.env --env-file=../../.env.local.d/db-release.env"
run node $E dist/database/jobs-migrate.js
run node $E dist/database/seed.js --dataset=reference
echo "-- rerun (must change nothing):"
run node $E dist/database/seed.js --dataset=reference
cd "$ROOT"

step "6. the two steps a clean database needs (CR-017-1 price table, CR-017-2 ledger grant), from the guide"
python3 - "$WORK" <<'PY'
import re, sys
guide = open("RUN-GUIDE.md").read()
sec = re.search(r"^## 6\..*?(?=^## )", guide, re.S | re.M).group(0)
node = re.search(r"^(node -e .*?)\s*\\\n", sec, re.S | re.M).group(1)
open(sys.argv[1] + "/price.sh", "w").write(node + "\n")
PY
run bash -c "bash '$WORK/price.sh' | psql -X -q -v ON_ERROR_STOP=1 '$(U migrator)'"
run psql -X -q -v ON_ERROR_STOP=1 "$(U migrator)" -c 'GRANT USAGE ON SCHEMA drizzle TO app_api_'"$SUF" -c 'GRANT SELECT ON drizzle.__drizzle_migrations TO app_api_'"$SUF"
echo "price_table rows: $(psql -X -At "$(U migrator)" -c 'select count(*) from price_table')"

step "7. run the api, worker and web"
cd apps/api
node --env-file=../../.env.local.d/api.env --env-file=../../.env.local.d/db-api.env dist/main.api.js > "$WORK/api.log" 2>&1 & PIDS+=($!)
node --env-file=../../.env.local.d/worker.env --env-file=../../.env.local.d/db-worker.env dist/main.worker.js > "$WORK/worker.log" 2>&1 & PIDS+=($!)
cd ../web
node --env-file=../../.env.local.d/web.env node_modules/next/dist/bin/next start -p 3010 > "$WORK/web.log" 2>&1 & PIDS+=($!)
cd "$ROOT"
sleep 12
chk() { local got; got="$(curl -s -o /dev/null -w '%{http_code}' "$2")"; printf '%s %s (expected %s)\n' "$1" "$got" "$3"; [ "$got" = "$3" ] || fail=1; }
chk "live"  http://localhost:4010/health/live 200
chk "ready" http://localhost:4010/health/ready 200
chk "protected route without a session" http://localhost:4010/api/v1/campaigns 401
chk "web sign-in" http://localhost:3010/sign-in 200
echo "worker log: $(grep -c . "$WORK/worker.log") lines; last: $(tail -1 "$WORK/worker.log" | cut -c1-140)"

step "8. operator commands"
cd apps/api
OA="--env-file=../../.env.local.d/api.env --env-file=../../.env.local.d/db-api.env"
run node $OA dist/bin/ops.js first-admin:reopen --env=development
run node $OA dist/bin/ops.js keys:disable-all --env=development
echo "-- wrong environment must be refused with exit 2:"
node $OA dist/bin/ops.js first-admin:reopen --env=production; echo "exit $?"
OW="--env-file=../../.env.local.d/worker.env --env-file=../../.env.local.d/db-worker.env"
run node $OW dist/bin/ops.js kek:rewrap --env=development
echo "-- erasure:resume with an unknown run id: audit event with outcome failed, exit 1:"
node $OW dist/bin/ops.js erasure:resume 00000000-0000-4000-8000-000000000000 --env=development; echo "exit $?"
cd "$ROOT"
echo "audit events written by the operator commands (actor_type, action, outcome):"
psql -X -At "$(U migrator)" -c "select actor_type, action, outcome from audit_events where actor_type = 'operator' order by action, outcome"

step "9. checks that need no service"
run node scripts/ci/config-consistency.mjs
run scripts/ci/docs-check.sh
exit $fail
