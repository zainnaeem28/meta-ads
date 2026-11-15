#!/usr/bin/env bash
# The locked release job for one environment (DEVOPS-PLAN 14.3). Holds an environment lock for the whole run,
# verifies the G3 approval before any mutation, then runs backup, migrate (checkpoints), deploy api, worker, web,
# smoke and observe through a host adapter. Recovery follows the approved procedure only (previous digests, never
# the database) and nothing is redeployed or retried automatically. A failed recovery leaves the job red.
# Reads no deployment credential: the host adapter owns any credential it needs.
#
#   release-with-recovery.sh --out-dir DIR <arguments of verify-release-approval.sh>
# Environment:
#   HOST_ADAPTER                 stub (or another adapter in scripts/ci/hosts). Unset: verify, record
#                                "deployment-ready, not deployed" and exit 0.
#   RELEASE_LOCK_DIR             lock folder (default /tmp/shroomap-release-locks); RELEASE_LOCK_WAIT_SECONDS (3600)
#   MIGRATE_TIMEOUT_SECONDS      abort threshold per migration checkpoint (default 900)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="" environment="" releases="" g3_record="" source_sha="" run_id=""
verify_args=()
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "release: missing value for $1" >&2; exit 64; }
  case "$1" in
    --out-dir) out="$2" ;;
    *)
      verify_args+=("$1" "$2")
      case "$1" in
        --environment) environment="$2" ;;
        --release-record) releases="$2" ;;
        --g3-record) g3_record="$2" ;;
        --source-sha) source_sha="$2" ;;
        --run-id) run_id="$2" ;;
      esac ;;
  esac
  shift 2
done
[ -n "$out" ] || { echo "release: --out-dir is required" >&2; exit 64; }
case "$environment" in staging | production) ;; *) echo "release: environment must be staging or production" >&2; exit 64 ;; esac
mkdir -p "$out"
result="$out/deployment-result-$environment.json"
alerts="$out/alerts-$environment.log"
state="$out/state-$environment.log"
: >"$state"

write_result() { # write_result STATUS DETAIL
  jq -n --arg status "$1" --arg detail "$2" --arg env "$environment" --arg sha "$source_sha" --arg run "$run_id" \
    --arg adapter "${HOST_ADAPTER:-none}" --argjson steps "$(jq -R . "$state" | jq -s .)" \
    '{status: $status, detail: $detail, environment: $env, sourceSha: $sha, runId: $run, adapter: $adapter, steps: $steps}' >"$result"
  echo "release: $1: $2"
}

if [ -z "${HOST_ADAPTER:-}" ]; then
  if [ -n "$g3_record" ]; then "$here/verify-release-approval.sh" "${verify_args[@]}" || { write_result approval-rejected "approval check failed"; exit 1; }; fi
  write_result deployment-ready-not-deployed "no host adapter configured; owner adds RENDER_API_KEY, the Render service ids, PAPERCLIP_G3_READER_TOKEN and the environment's secrets (docs/ops/secrets.md)"
  exit 0
fi

case "$HOST_ADAPTER" in *[!a-z0-9-]* | "") echo "release: invalid HOST_ADAPTER" >&2; exit 64 ;; esac
adapter="$here/hosts/$HOST_ADAPTER.sh"
[ -x "$adapter" ] || { echo "release: host adapter $HOST_ADAPTER does not exist" >&2; exit 64; }
export STUB_CALLS_FILE="${STUB_CALLS_FILE:-$out/host-calls-$environment.log}"
host() { "$adapter" "$@"; }

alert() { # alert MESSAGE: failures to alert are shown but never hide the original failure
  echo "$(date -u +%FT%TZ) $environment $1" >>"$alerts"
  echo "::error::release $environment: $1" >&2
  host alert "$1" >/dev/null 2>&1 || echo "release: the alert call itself failed; see $alerts" >&2
}
step() { echo "$1" >>"$state"; echo "release: step $1"; }

lock_dir="${RELEASE_LOCK_DIR:-/tmp/shroomap-release-locks}"
mkdir -p "$lock_dir"
exec 9>"$lock_dir/release-$environment.lock"
if ! flock -n 9; then
  echo "release: another release holds the $environment lock; waiting"
  flock -w "${RELEASE_LOCK_WAIT_SECONDS:-3600}" 9 || { write_result lock-timeout "gave up waiting for the $environment lock"; exit 1; }
fi

# Step 1: preflight. Nothing has changed when this fails.
"$here/verify-release-approval.sh" "${verify_args[@]}" || { write_result approval-rejected "approval check failed, host adapter not reached"; exit 1; }
step preflight
digest() { jq -r --arg k "$1" '.digests[$k]' "$g3_record"; }
previous="$(jq -c --arg e "$environment" '[.[] | select(.environment == $e)] | last // empty' "$releases")"
prev() { [ -n "$previous" ] && jq -r --arg k "$1" '.digests[$k] // empty' <<<"$previous"; }
host schema-version >/dev/null && host backup-gate >/dev/null || { write_result preflight-failed "schema read or backup gate failed, nothing changed"; exit 1; }

# Step 2: backup.
backup_id="$(host backup)" || { alert "backup failed, nothing changed"; write_result backup-failed "nothing changed"; exit 1; }
step "backup:$backup_id"

# Step 3: migrate. A failed or slow checkpoint halts: no retry, no data rollback, the old application stays active.
for checkpoint in migrate-db migrate-jobs; do
  timeout "${MIGRATE_TIMEOUT_SECONDS:-900}" "$adapter" "$checkpoint" "$backup_id" >/dev/null
  rc=$?
  if [ "$rc" -ne 0 ]; then
    reason="failed"; [ "$rc" -eq 124 ] && reason="exceeded ${MIGRATE_TIMEOUT_SECONDS:-900}s"
    alert "$checkpoint $reason; halted. Old application remains active; incident owner decides forward fix or restore from $backup_id"
    write_result migration-halted "$checkpoint $reason; no automatic retry or data rollback"
    exit 1
  fi
  step "$checkpoint"
done

# Recovery: only previous digests, newest layer first, never the database. A failing recovery step stops everything.
recover() { # recover REASON
  local deployed=("$@")
  unset 'deployed[0]'
  [ -n "$previous" ] || { alert "$1; no previous release is recorded, so no approved recovery exists"; write_result recovery-failed "$1; nothing to recover to"; exit 2; }
  for svc in web worker api; do
    case " ${deployed[*]} " in *" $svc "*) ;; *) continue ;; esac
    if ! host "rollback-$svc" "$(prev "$svc")" >/dev/null; then
      alert "$1; recovery step rollback-$svc failed. Job stays failed, evidence preserved, no further action taken"
      write_result recovery-failed "$1; rollback-$svc failed"
      exit 2
    fi
    step "rollback-$svc"
  done
  alert "$1; recovered to the previous digests. The release did not ship; the database is not restored"
  write_result rolled-back "$1; recovered to previous digests"
  exit 1
}

# Steps 4 to 6: deploy api, worker, web. A failed deploy keeps the previous service and stops promotion.
deployed=()
for svc in api worker web; do
  if ! host "deploy-$svc" "$(digest "$svc")" >/dev/null; then
    alert "deploy-$svc failed; previous $svc kept, promotion stopped"
    [ "${#deployed[@]}" -eq 0 ] && { write_result deploy-halted "deploy-$svc failed; nothing was promoted"; exit 1; }
    recover "deploy-$svc failed" "${deployed[@]}"
  fi
  deployed+=("$svc"); step "deploy-$svc"
done

# Steps 7 and 8: smoke and observe.
for phase in smoke observe; do
  host "$phase" >/dev/null || recover "$phase failed" "${deployed[@]}"
  step "$phase"
done

# Step 9: record. A failed record step is reported, never hidden.
write_result released "api, worker and web deployed by digest, smoke and observation passed"
host record "$result" >/dev/null || { alert "release record step failed after a successful release"; exit 1; }
