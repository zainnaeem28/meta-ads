#!/usr/bin/env bash
# Render host adapter (DEVOPS-PLAN 6.1, 14.3). Same operations as hosts/stub.sh, run against the Render API.
# Every Render fact here is marked VERIFY in docs/ops/release.md and is exercised only against the recorded
# fixtures; a real environment needs its own G3 and the credentials below. The key is read from the environment
# and passed to curl through its config on stdin, never on a command line, in a file or in output.
#
#   render.sh schema-version | backup-gate | backup | migrate-db BACKUP_ID | migrate-jobs BACKUP_ID
#   render.sh deploy-api|deploy-worker|deploy-web DIGEST | rollback-api|rollback-worker|rollback-web DIGEST
#   render.sh smoke | observe | alert MESSAGE | record RESULT_FILE
# Environment:
#   RENDER_API_KEY, RENDER_SERVICE_API, RENDER_SERVICE_WORKER, RENDER_SERVICE_WEB, RENDER_SERVICE_MIGRATE,
#   RENDER_POSTGRES_ID, RELEASE_IMAGE_PREFIX (registry path; the image is PREFIX/<service>@DIGEST),
#   RELEASE_G3_RECORD (the G3 record file), RENDER_SMOKE_API_URL, RENDER_SMOKE_WEB_URL    required (exit 78 without)
#   RENDER_API_URL (https://api.render.com/v1), RENDER_POLL_SECONDS (10), RENDER_DEPLOY_TIMEOUT_SECONDS (900),
#   RENDER_JOB_TIMEOUT_SECONDS (900), RENDER_WORKER_SHUTDOWN_DELAY (120), RENDER_BACKUP_MAX_AGE_HOURS (24),
#   RENDER_CMD_MIGRATE ("pnpm db:migrate"), RENDER_CMD_JOBS ("pnpm jobs:migrate"),
#   RENDER_CMD_SEED ("pnpm db:seed --dataset=reference"), SMOKE_ATTEMPTS (10), SMOKE_INTERVAL_SECONDS (15),
#   ALERT_WEBHOOK_URL, RELEASE_NOW (epoch seconds, tests only)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
op="${1:-}"
[ -n "$op" ] || { echo "render: no operation given" >&2; exit 64; }
shift

command -v jq >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || { echo "render: jq and curl are required" >&2; exit 69; }

if [ "$op" = alert ]; then
  echo "render: ALERT: ${1:-no message}" >&2
  [ -z "${ALERT_WEBHOOK_URL:-}" ] || curl -sS --max-time 15 -X POST -H 'Content-Type: application/json' \
    --data "$(jq -n --arg text "${1:-}" '{text: $text}')" "$ALERT_WEBHOOK_URL" >/dev/null
  exit 0
fi

missing=()
for name in RENDER_API_KEY RENDER_SERVICE_API RENDER_SERVICE_WORKER RENDER_SERVICE_WEB RENDER_SERVICE_MIGRATE \
  RENDER_POSTGRES_ID RELEASE_IMAGE_PREFIX RELEASE_G3_RECORD RENDER_SMOKE_API_URL RENDER_SMOKE_WEB_URL; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "render: deployment-ready, not deployed: the owner still adds ${missing[*]} (docs/ops/release.md)" >&2
  exit 78
fi

base="${RENDER_API_URL:-https://api.render.com/v1}"
poll="${RENDER_POLL_SECONDS:-10}"
now() { echo "${RELEASE_NOW:-$(date +%s)}"; }
die() { echo "render: $*" >&2; exit 1; }

api() { # api METHOD PATH [JSON_BODY]: prints the response body, fails on any non-2xx status
  local out code
  out="$(mktemp)"
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$RENDER_API_KEY" | curl -sS -K - --max-time 60 -o "$out" \
    -w '%{http_code}' -X "$1" -H 'Accept: application/json' ${3:+-H 'Content-Type: application/json' --data "$3"} "$base$2")" \
    || { rm -f "$out"; die "$1 $2: no response"; }
  case "$code" in
    2??) cat "$out"; rm -f "$out" ;;
    *) rm -f "$out"; die "$1 $2: HTTP $code" ;;
  esac
}

service_id() { # service_id api|worker|web|migrate
  local name="RENDER_SERVICE_${1^^}"
  echo "${!name}"
}

digest_ok() { [[ "${1:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "not an image digest: ${1:-empty}"; }

wait_deploy() { # wait_deploy SERVICE_ID DEPLOY_ID DIGEST
  local deadline status body
  deadline=$(($(now) + ${RENDER_DEPLOY_TIMEOUT_SECONDS:-900}))
  while :; do
    body="$(api GET "/services/$1/deploys/$2")"
    status="$(jq -r '.status // "unknown"' <<<"$body")"
    case "$status" in
      live)
        [ "$(jq -r '.image.sha // ""' <<<"$body")" = "$3" ] || die "deploy $2 is live but not on $3"
        return 0 ;;
      build_failed | update_failed | pre_deploy_failed | canceled | deactivated) die "deploy $2 ended as $status" ;;
    esac
    [ "$(now)" -lt "$deadline" ] || die "deploy $2 not live in time (last status $status)"
    sleep "$poll"
  done
}

deploy() { # deploy SERVICE_NAME DIGEST [IMAGE_NAME]: the image is named after the service unless told otherwise
  local id deploy_id
  digest_ok "$2"
  id="$(service_id "$1")"
  deploy_id="$(api POST "/services/$id/deploys" "$(jq -n --arg url "$RELEASE_IMAGE_PREFIX/${3:-$1}@$2" '{imageUrl: $url}')" | jq -r '.id // empty')"
  [ -n "$deploy_id" ] || die "Render accepted the deploy of $1 without an id"
  wait_deploy "$id" "$deploy_id" "$2"
  echo "render: $1 live on $2"
}

wait_job() { # wait_job JOB_ID COMMAND
  local deadline status
  deadline=$(($(now) + ${RENDER_JOB_TIMEOUT_SECONDS:-900}))
  while :; do
    status="$(api GET "/services/$RENDER_SERVICE_MIGRATE/jobs/$1" | jq -r '.status // "unknown"')"
    case "$status" in
      succeeded) return 0 ;;
      failed | canceled) die "job '$2' ended as $status" ;;
    esac
    [ "$(now)" -lt "$deadline" ] || die "job '$2' still $status after the timeout"
    sleep "$poll"
  done
}

run_job() { # run_job COMMAND: one Render Job on the migrate service
  local job_id
  job_id="$(api POST "/services/$RENDER_SERVICE_MIGRATE/jobs" "$(jq -n --arg cmd "$1" '{startCommand: $cmd}')" | jq -r '.id // empty')"
  [ -n "$job_id" ] || die "Render accepted the job '$1' without an id"
  wait_job "$job_id" "$1"
  echo "render: job '$1' succeeded"
}

case "$op" in
  schema-version)
    # Reads what is live now; the preflight compares it with the release record (cross-check, DEVOPS-PLAN 7.5).
    for svc in api worker web migrate; do
      api GET "/services/$(service_id "$svc")" >/dev/null
      echo "render: $svc reachable"
    done
    echo "render-live-state-read"
    ;;
  backup-gate)
    newest="$(api GET "/postgres/$RENDER_POSTGRES_ID/export" | jq -r '[.[]? | .createdAt // empty | fromdateiso8601] | max // 0')"
    limit=$((${RENDER_BACKUP_MAX_AGE_HOURS:-24} * 3600))
    [ $(($(now) - newest)) -le "$limit" ] || die "no backup of the database younger than ${RENDER_BACKUP_MAX_AGE_HOURS:-24} hours"
    echo "render: backup gate passed"
    ;;
  backup)
    id="$(api POST "/postgres/$RENDER_POSTGRES_ID/export" '{}' | jq -r '.id // empty')"
    [ -n "$id" ] || die "Render accepted the backup without an id"
    echo "$id"
    ;;
  migrate-db)
    [ -n "${1:-}" ] || die "migrate-db needs the backup id"
    # The migration runs the new api image: point the migrate service at the approved api digest first.
    api_digest="$(jq -r '.digests.api // empty' "$RELEASE_G3_RECORD")"
    deploy migrate "$api_digest" api
    run_job "${RENDER_CMD_MIGRATE:-pnpm db:migrate}"
    ;;
  migrate-jobs)
    [ -n "${1:-}" ] || die "migrate-jobs needs the backup id"
    run_job "${RENDER_CMD_JOBS:-pnpm jobs:migrate}"
    run_job "${RENDER_CMD_SEED:-pnpm db:seed --dataset=reference}"
    ;;
  deploy-api | deploy-web)
    deploy "${op#deploy-}" "${1:-}"
    ;;
  deploy-worker)
    # The old worker drains on SIGTERM inside the shutdown delay (VERIFY the maximum Render allows).
    api PATCH "/services/$RENDER_SERVICE_WORKER" "$(jq -n --argjson s "${RENDER_WORKER_SHUTDOWN_DELAY:-120}" '{serviceDetails: {maxShutdownDelaySeconds: $s}}')" >/dev/null
    deploy worker "${1:-}"
    ;;
  rollback-api | rollback-worker | rollback-web)
    svc="${op#rollback-}"
    digest_ok "${1:-}"
    # The target must be a digest this service really ran (the release record and the host must agree).
    api GET "/services/$(service_id "$svc")/deploys?limit=50" | jq -e --arg d "$1" 'any(.[]?; (.deploy // .).image.sha == $d)' >/dev/null \
      || die "rollback target $1 is not in the deploy history of $svc"
    deploy "$svc" "$1"
    ;;
  smoke)
    attempts="${SMOKE_ATTEMPTS:-10}"
    for ((i = 1; i <= attempts; i++)); do
      if curl -fsS --max-time 20 -o /dev/null "$RENDER_SMOKE_API_URL/health/ready" && curl -fsS --max-time 20 -o /dev/null "$RENDER_SMOKE_WEB_URL"; then
        echo "render: smoke passed on attempt $i"
        exit 0
      fi
      [ "$i" -eq "$attempts" ] || sleep "${SMOKE_INTERVAL_SECONDS:-15}"
    done
    die "smoke failed after $attempts attempts"
    ;;
  observe)
    OBSERVE_API_URL="${OBSERVE_API_URL:-$RENDER_SMOKE_API_URL}" exec "$here/../observe.sh"
    ;;
  record)
    result="${1:-}"
    [ -r "$result" ] || die "record needs the deployment result file"
    entry="$(dirname "$result")/release-record-entry-$(jq -r '.environment' "$result").json"
    jq -n --slurpfile r "$result" --slurpfile g "$RELEASE_G3_RECORD" --argjson at "$(now)" \
      '{environment: $r[0].environment, digests: $g[0].digests, recordedAt: ($at | todate), runId: $r[0].runId, g3Ref: $g[0].ref, sourceSha: $r[0].sourceSha, result: $r[0].status}' >"$entry"
    echo "render: release record entry written to $entry"
    ;;
  *)
    echo "render: unknown operation $op" >&2
    exit 64
    ;;
esac
