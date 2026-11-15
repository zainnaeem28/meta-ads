#!/usr/bin/env bash
# Observation window after a release (DEVOPS-PLAN 14.4, 11.4). Polls the api's health and its windowed metrics
# summary and aborts (exit 1) as soon as a threshold is crossed, so the release job recovers. Exit 0 means the
# whole window passed. A single passing health response is never release success.
# Abort when: /health/ready fails 3 probes in a row; the 5xx ratio is over 2% with at least 100 requests; p95 is over
# twice the baseline with at least 200 requests; a job is stuck in submitting; the KEK unseal alert fired; or the
# worker heartbeat is older than 15 minutes. The metrics path and field names are VERIFY (requested of AIU-13).
# Environment:
#   OBSERVE_API_URL (required), METRICS_TOKEN (required: the api's metrics access check)
#   OBSERVE_WINDOW_SECONDS (3600), OBSERVE_INTERVAL_SECONDS (300), OBSERVE_BASELINE_P95_MS (required for the p95 check)
#   OBSERVE_MAX_5XX_RATIO (0.02), OBSERVE_MIN_REQUESTS_5XX (100), OBSERVE_P95_FACTOR (2), OBSERVE_MIN_REQUESTS_P95 (200),
#   OBSERVE_HEARTBEAT_MAX_SECONDS (900), OBSERVE_NOW (epoch seconds, tests only)
set -uo pipefail

url="${OBSERVE_API_URL:-}"
[ -n "$url" ] || { echo "observe: OBSERVE_API_URL is required" >&2; exit 64; }
[ -n "${METRICS_TOKEN:-}" ] || { echo "observe: METRICS_TOKEN is required" >&2; exit 64; }
command -v jq >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || { echo "observe: jq and curl are required" >&2; exit 69; }
window="${OBSERVE_WINDOW_SECONDS:-3600}"
interval="${OBSERVE_INTERVAL_SECONDS:-300}"
now() { echo "${OBSERVE_NOW:-$(date +%s)}"; }

abort() { echo "observe: ABORT: $1" >&2; exit 1; }
metrics() { printf 'header = "Authorization: Bearer %s"\n' "$METRICS_TOKEN" | curl -fsS -K - --max-time 20 "$url/internal/metrics/window"; }

end=$(($(now) + window))
failed_probes=0
rounds=0
while :; do
  rounds=$((rounds + 1))
  if curl -fsS --max-time 20 -o /dev/null "$url/health/ready"; then failed_probes=0; else failed_probes=$((failed_probes + 1)); fi
  [ "$failed_probes" -lt 3 ] || abort "/health/ready failed $failed_probes probes in a row"

  summary="$(metrics)" || abort "the metrics summary cannot be read, so the window cannot be judged"
  field() { jq -r "$1 // 0" <<<"$summary"; }
  requests="$(field .requests)"
  [ "$requests" -lt "${OBSERVE_MIN_REQUESTS_5XX:-100}" ] \
    || jq -e --argjson r "$requests" --argjson e "$(field .errors5xx)" --argjson max "${OBSERVE_MAX_5XX_RATIO:-0.02}" '$e / $r <= $max' >/dev/null <<<null \
    || abort "5xx ratio over ${OBSERVE_MAX_5XX_RATIO:-0.02} with $requests requests"
  if [ "$requests" -ge "${OBSERVE_MIN_REQUESTS_P95:-200}" ]; then
    [ -n "${OBSERVE_BASELINE_P95_MS:-}" ] || abort "OBSERVE_BASELINE_P95_MS is required once the p95 sample is large enough"
    jq -e --argjson p "$(field .p95Ms)" --argjson b "$OBSERVE_BASELINE_P95_MS" --argjson f "${OBSERVE_P95_FACTOR:-2}" '$p <= $b * $f' >/dev/null <<<null \
      || abort "p95 $(field .p95Ms) ms is over ${OBSERVE_P95_FACTOR:-2}x the $OBSERVE_BASELINE_P95_MS ms baseline"
  fi
  [ "$(field .stuckSubmitting)" -eq 0 ] || abort "$(field .stuckSubmitting) job(s) stuck in submitting"
  [ "$(field .kekUnsealFailures)" -eq 0 ] || abort "KEK unseal failure alert fired"
  [ "$(field .workerHeartbeatAgeSeconds)" -le "${OBSERVE_HEARTBEAT_MAX_SECONDS:-900}" ] || abort "worker heartbeat is $(field .workerHeartbeatAgeSeconds) s old"

  [ "$(now)" -lt "$end" ] || break
  sleep "$interval"
done
echo "observe: window of ${window}s passed in $rounds round(s)"
