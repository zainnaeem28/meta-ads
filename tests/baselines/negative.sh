#!/usr/bin/env bash
# Negative tests of the baselines (acceptance: "a run answered mostly by 401s is rejected"). Each wrapper is run in smoke
# mode with every session replaced by one the stack refuses; the wrapper must exit non-zero and say why. The runs write
# to their own reports folder so they never overwrite the baseline reports. Records one case per wrapper in the junit.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BL="$ROOT/tests/baselines"
MAIN="${CI_REPORTS_DIR:-$ROOT/reports}"
export CI_REPORTS_DIR="$MAIN/negative"
rm -rf "$CI_REPORTS_DIR"; mkdir -p "$CI_REPORTS_DIR"
fails=0
check() { # name expected-text command...
  local name="$1" expect="$2"; shift 2
  local log="$CI_REPORTS_DIR/$name.log" rc=0
  "$@" >"$log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && grep -qi "$expect" "$log"; then
    echo "PASS $name: rejected with exit $rc ($expect)"; status=pass; msg="rejected with exit $rc"
  else
    echo "FAIL $name: exit $rc, expected a rejection mentioning '$expect' (see $log)"; status=fail; msg="exit $rc, no rejection"; fails=$((fails + 1))
  fi
  CI_REPORTS_DIR="$MAIN" node "$BL/lib/results.mjs" add negative "TC-NFR-10 invalid sessions are rejected: $name" "$status" "$msg"
}
CI_REPORTS_DIR="$MAIN" node "$BL/lib/results.mjs" reset negative
check load "401s" "$ROOT/scripts/ci/load.sh" --smoke --invalid-session
check dast "not a baseline" "$ROOT/scripts/ci/dast.sh" --baseline --smoke --invalid-session
check lighthouse "valid samples" "$ROOT/scripts/ci/lighthouse.sh" --smoke --invalid-session
exit "$fails"
