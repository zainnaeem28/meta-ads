#!/usr/bin/env bash
# Create the database roles and grants, or read them back (DO-11, TASK-018). Idempotent.
#
#   scripts/provision/roles.sh apply  [--rotate]    sql/roles.sql then sql/verify.sql
#   scripts/provision/roles.sh verify               sql/verify.sql only (read-only)
#
# Environment (names only; values are never printed):
#   PROVISION_DATABASE_URL        the host admin's connection URL to the application database (secret; never in a file)
#   PROVISION_PW_MIGRATOR, PROVISION_PW_API, PROVISION_PW_WORKER, PROVISION_PW_BACKUP   role passwords (secret)
#   PROVISION_APP_DB (shroomap), PROVISION_ROLE_SUFFIX (empty; the tests use it), PROVISION_PEAK (47)
#   PROVISION_ENVIRONMENT (staging|production) and PROVISION_G3_RECORD (apply on a hosted database: scripts/provision/gate.sh)
#   PROVISION_LOCAL=1 (apply only: the target is the local stack or the shared test server, host localhost or test-db)
#   PSQL_BIN (psql)
# Without PROVISION_DATABASE_URL it makes no connection and exits 0 with "deployment-ready-not-deployed", listing what the
# owner adds. Exit 1 on a failed statement or read-back, 2 on a usage error.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSQL="${PSQL_BIN:-psql}"
mode="${1:-}"; shift || true
rotate=0
for a in "$@"; do case "$a" in --rotate) rotate=1 ;; *) echo "unknown argument: $a" >&2; exit 2 ;; esac; done
case "$mode" in apply | verify) ;; *) echo "usage: roles.sh apply [--rotate] | verify" >&2; exit 2 ;; esac

if [ -z "${PROVISION_DATABASE_URL:-}" ]; then
  echo "roles: deployment-ready-not-deployed: no database connection; the owner sets PROVISION_DATABASE_URL (the host admin's URL), and for apply PROVISION_PW_MIGRATOR, PROVISION_PW_API, PROVISION_PW_WORKER and PROVISION_PW_BACKUP (docs/ops/provisioning.md)"
  exit 0
fi
if [ "$mode" = apply ]; then
  # shellcheck source=gate.sh
  source "$HERE/gate.sh"
  host="$(printf '%s' "$PROVISION_DATABASE_URL" | sed -E 's|^[a-z]+://[^@]*@([^:/?]+).*|\1|')"
  local_target=0
  case "$host" in localhost | 127.0.0.1 | ::1 | test-db | db-test*) [ "${PROVISION_LOCAL:-}" = 1 ] && local_target=1 ;; esac
  require_g3 "${PROVISION_ENVIRONMENT:-}" "$local_target" || exit 1
fi
sfx="${PROVISION_ROLE_SUFFIX:-}"
vars=(-v "app_db=${PROVISION_APP_DB:-shroomap}" -v "r_migrator=app_migrator$sfx" -v "r_api=app_api$sfx" -v "r_worker=app_worker$sfx"
  -v "r_backup=app_backup$sfx" -v "rotate=$rotate" -v "peak=${PROVISION_PEAK:-47}")
run() { "$PSQL" -X -q -v ON_ERROR_STOP=1 "${vars[@]}" -f "$HERE/sql/$1" "$PROVISION_DATABASE_URL" 2>&1 | grep -v "no privileges could be revoked" | sed -E 's/^psql:[^:]+:[0-9]+: //; s/^NOTICE:  //'; return "${PIPESTATUS[0]}"; }
if [ "$mode" = apply ]; then
  run roles.sql || { echo "roles: apply FAILED" >&2; exit 1; }
fi
run verify.sql || { echo "roles: read-back FAILED" >&2; exit 1; }
echo "roles: $mode complete"
