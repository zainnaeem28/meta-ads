#!/usr/bin/env bash
# The G3 gate for anything that creates or changes a resource (DO-11: "No resource is created before the G3 for that
# environment"). Source it; never run it. require_g3 ENVIRONMENT TARGET_IS_LOCAL
#   PROVISION_G3_RECORD   the environment's G3 record (JSON with decision PASS and environment), a file the owner downloads
# A local or test target (a disposable server named by the caller) needs no G3; every other target does.
require_g3() {
  local env="$1" local_target="$2" rec="${PROVISION_G3_RECORD:-}"
  [ "$local_target" = 1 ] && return 0
  case "$env" in staging | production) ;; *) echo "refusing: PROVISION_ENVIRONMENT must be staging or production for a hosted target" >&2; return 1 ;; esac
  [ -n "$rec" ] && [ -r "$rec" ] || { echo "refusing: no G3 record for $env (PROVISION_G3_RECORD); nothing is created before the G3 for that environment" >&2; return 1; }
  [ "$(jq -r '.decision // ""' "$rec" 2>/dev/null)" = PASS ] || { echo "refusing: the G3 record is not a PASS" >&2; return 1; }
  [ "$(jq -r '.environment // ""' "$rec" 2>/dev/null)" = "$env" ] || { echo "refusing: the G3 record names another environment than $env" >&2; return 1; }
}
