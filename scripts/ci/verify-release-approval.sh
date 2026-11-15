#!/usr/bin/env bash
# Verifies that a recorded G3 approval covers exactly this release (DEVOPS-PLAN 14.2). Fails closed: any missing
# input, unreadable file or mismatch exits non-zero before a host adapter can be reached. Reads no credential;
# the G3 record and the other evidence are files the workflow fetched earlier.
#
#   verify-release-approval.sh --environment staging|production --source-sha SHA --run-id N --ref REF \
#     --g3-record FILE --quality FILE --actual-digests FILE --expected-targets FILE --release-record FILE \
#     --dispatcher NAME [--g3-sha256 HASH] [--identity-mode shared|restricted]
# Environment: RELEASE_NOW (epoch seconds, tests only), G3_MAX_AGE_HOURS (default 72).
set -uo pipefail

environment="" source_sha="" run_id="" ref="" g3_record="" quality="" actual="" targets="" releases=""
dispatcher="" g3_sha="" identity_mode="shared"
while [ $# -gt 0 ]; do
  case "$1" in
    --environment) environment="${2-}" ;;
    --source-sha) source_sha="${2-}" ;;
    --run-id) run_id="${2-}" ;;
    --ref) ref="${2-}" ;;
    --g3-record) g3_record="${2-}" ;;
    --quality) quality="${2-}" ;;
    --actual-digests) actual="${2-}" ;;
    --expected-targets) targets="${2-}" ;;
    --release-record) releases="${2-}" ;;
    --dispatcher) dispatcher="${2-}" ;;
    --g3-sha256) g3_sha="${2-}" ;;
    --identity-mode) identity_mode="${2-}" ;;
    *) echo "verify-release-approval: unknown argument $1" >&2; exit 64 ;;
  esac
  shift 2 || { echo "verify-release-approval: missing value for $1" >&2; exit 64; }
done

failures=0
check() { # check NAME REASON-IF-FAILED CONDITION-EXIT-CODE
  if [ "$3" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1: $2" >&2; failures=$((failures + 1)); fi
}
stop() { echo "FAIL $1: $2" >&2; echo "approval: REJECTED, no mutation allowed" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || stop tooling "jq is not installed"
case "$environment" in staging | production) ;; *) stop input "environment must be staging or production" ;; esac
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || stop input "source-sha must be a 40 character commit"
[[ "$run_id" =~ ^[0-9]+$ ]] || stop input "run-id must be a number"
[ -n "$dispatcher" ] || stop input "dispatcher is required"
for file in "$g3_record" "$quality" "$actual" "$targets" "$releases"; do
  [ -n "$file" ] && [ -r "$file" ] || stop input "evidence file missing or unreadable: ${file:-unset}"
  jq -e . "$file" >/dev/null 2>&1 || stop input "evidence file is not valid JSON: $file"
done

[ "$ref" = "refs/heads/main" ]; check dispatch-ref "dispatch ref is '$ref', must be refs/heads/main" $?

if [ -n "$g3_sha" ]; then
  [ "$(sha256sum "$g3_record" | cut -d' ' -f1)" = "$g3_sha" ]; check g3-hash "G3 record does not match its recorded hash" $?
fi

g3() { jq -r "$1" "$g3_record"; }
[ "$(g3 '.decision // ""')" = "PASS" ]; check g3-decision "G3 decision is not PASS" $?
g3_environment="$(g3 '.environment // "none"')"
[ "$g3_environment" = "$environment" ]; check g3-environment "G3 names '$g3_environment', not $environment" $?
[ "$(g3 '.sourceSha // ""')" = "$source_sha" ]; check g3-source "G3 names a different source commit" $?

want_digests="$(g3 '.digests // {} | {api, worker, web}' | jq -cS .)"
jq -e '[.api, .worker, .web] | all(type == "string" and test("^sha256:[0-9a-f]{64}$"))' <<<"$want_digests" >/dev/null 2>&1
check g3-digests-shape "G3 must name an api, worker and web sha256 digest" $?
[ "$want_digests" = "$(jq -cS '{api, worker, web}' "$actual")" ]; check digests-registry "G3 digests differ from the registry digests" $?
[ "$want_digests" = "$(jq -cS '.digests // {} | {api, worker, web}' "$quality")" ]; check digests-quality "G3 digests differ from quality.json" $?

[ "$(jq -r '.sourceSha // ""' "$quality")" = "$source_sha" ]; check quality-source "quality.json is for another commit" $?
[ "$(jq -r '.result // ""' "$quality")" = "PASS" ]; check quality-result "quality.json result is not PASS" $?
[ "$(g3 '.qualitySha256 // ""')" = "$(sha256sum "$quality" | cut -d' ' -f1)" ]; check quality-hash "quality.json differs from the one G3 approved" $?
[ -n "$(g3 '.planRevision // ""')" ]; check plan-revision "G3 names no DEPLOYMENT-PLAN revision" $?

want_targets="$(g3 '.targets // {}' | jq -cS .)"
[ "$want_targets" != "{}" ] && [ "$want_targets" = "$(jq -cS --arg e "$environment" '.[$e] // {}' "$targets")" ]
check targets "hosts, database or bucket differ from the environment's expected values" $?

now="${RELEASE_NOW:-$(date +%s)}"
approved="$(g3 '.approvedAt // ""' | xargs -r -I{} date -d {} +%s 2>/dev/null)"
max_age=$(( ${G3_MAX_AGE_HOURS:-72} * 3600 ))
[[ "$approved" =~ ^[0-9]+$ ]] && [ "$approved" -le "$now" ] && [ $((now - approved)) -le "$max_age" ]
check g3-fresh "G3 approval is missing a valid time, is in the future, or is older than ${G3_MAX_AGE_HOURS:-72} hours" $?

g3_ref="$(g3 '.ref // ""')"
last_run="$(jq -r --arg e "$environment" '[.[] | select(.environment == $e) | .runId | tonumber] | max // 0' "$releases" 2>/dev/null || echo bad)"
[[ "$last_run" =~ ^[0-9]+$ ]] && [ "$run_id" -ge "$last_run" ] \
  && ! jq -e --arg e "$environment" --arg r "$g3_ref" '.[] | select(.environment == $e and .g3Ref == $r)' "$releases" >/dev/null
check not-stale "run is older than the last release for $environment, or this G3 was already used" $?

if [ "$identity_mode" = "restricted" ]; then
  [ "$dispatcher" != "$(g3 '.writtenBy // ""')" ]; check identity "the dispatcher wrote the G3 record" $?
else
  echo "UNPROVABLE identity: one shared identity exists (DOP-OI-2b); not evidence of separation"
fi

if [ "$failures" -gt 0 ]; then echo "approval: REJECTED ($failures failed), no mutation allowed" >&2; exit 1; fi
echo "approval: ACCEPTED for $environment at $source_sha"
