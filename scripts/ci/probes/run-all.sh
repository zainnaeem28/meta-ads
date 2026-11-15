#!/usr/bin/env bash
# Gate probes 1-6 (DEVOPS-PLAN section 15) and the five layer probes (ARCHITECTURE section 1.4).
# Each probe damages one thing in an otherwise green set of reports (or fixture tree) and passes only when the
# real gate (quality-gate.sh / layers.sh) fails and says why. A clean set must pass. Exit 0 only when every
# probe behaves. Fixtures are inert and are not part of any release artifact.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
SHA="$(git rev-parse HEAD)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
GATE_OUT="$WORK/out.txt"

assemble() { python3 -I "$HERE/assemble.py" "$WORK/reports" "$SHA" "$@"; }
# gate WORKFLOW-FIXTURE: run the real gate on $WORK/reports, ticket profile, output kept in $GATE_OUT.
gate() {
  CI_REPORTS_DIR="$WORK/reports" CI_SOURCE_SHA="$SHA" "$ROOT/scripts/ci/quality-gate.sh" --profile ticket \
    --workflow "$HERE/gate/${1:-workflow-complete.yml}" "${@:2}" >"$GATE_OUT" 2>&1
}
# expect_fail LABEL PATTERN: the last gate run must have failed and printed PATTERN.
expect_fail() {
  local rc=$?
  if [ "$rc" -ne 0 ] && grep -Eq -- "$2" "$GATE_OUT"; then
    printf 'PASS  %-58s gate exit %s: %s\n' "$1" "$rc" "$(grep -E -m1 -- "$2" "$GATE_OUT" | cut -c1-150)"
  else
    printf 'FAIL  %-58s expected a failing gate matching /%s/ (exit %s)\n' "$1" "$2" "$rc"; sed 's/^/      /' "$GATE_OUT"
    FAILED=$((FAILED + 1))
  fi
}
expect_pass() {
  local rc=$?
  if [ "$rc" -eq 0 ]; then printf 'PASS  %-58s gate exit 0: %s\n' "$1" "$(tail -1 "$GATE_OUT")"
  else printf 'FAIL  %-58s expected the gate to pass (exit %s)\n' "$1" "$rc"; sed 's/^/      /' "$GATE_OUT"; FAILED=$((FAILED + 1)); fi
}

echo "== commit $SHA"
echo "== gate probes (DEVOPS-PLAN section 15)"
assemble; gate; expect_pass "0  clean set of reports passes"
assemble --set unit-ci=junit-fail.xml; gate; expect_fail "1  one required unit test fails" "unit-ci.*1 test\(s\) failed"
assemble --set unit-ci=junit-zero.xml; gate; expect_fail "2a suite selects zero tests (runner exited 0)" "unit-ci.*only 0 test"
assemble --set unit-ci=junit-skipped.xml; gate; expect_fail "2b every selected test is skipped" "unit-ci.*only 0 test\(s\) ran \(2 skipped\)"
assemble --lcov lcov-low.info; gate; expect_fail "2c coverage below the policy minimum" "unit-ci.*coverage.*under the overall minimum"
assemble --status sast=fail; gate; expect_fail "3a scanner crashed (exit 2, no report)" "sast.*wrapper recorded a failure"
assemble --delete-report sast; gate; expect_fail "3b scanner report missing" "sast.*report file 'sast.sarif' is missing"
assemble --set sast=sarif-malformed.broken; gate; expect_fail "3c scanner report malformed" "sast.*not valid JSON"
assemble --set deps=sarif-crashed.sarif; gate; expect_fail "3d scanner says the scan did not finish" "deps.*executionSuccessful=false"
# 3f: a wrapper whose tool exits non-zero must exit non-zero and record a failure (no swallowed exit codes).
( CI_REPORTS_DIR="$WORK/wrapper" CI_SOURCE_SHA="$SHA" bash -c 'source "$1/scripts/ci/lib.sh"; run_summary probe-tool false false' _ "$ROOT" >/dev/null 2>&1 ); wrc=$?
if [ "$wrc" -ne 0 ] && grep -q '"status": "fail"' "$WORK/wrapper/meta/probe-tool.json"; then
  echo "PASS  3f wrapper exits non-zero and records fail when its tool fails (exit $wrc)"
else echo "FAIL  3f wrapper swallowed a tool failure (exit $wrc)"; FAILED=$((FAILED + 1)); fi
assemble --drop-meta secrets; gate; expect_fail "3e wrapper never ran (no meta file)" "secrets.*no meta file"
assemble --set sast=sarif-critical.sarif; gate; expect_fail "4  synthetic Critical finding" "sast.*BLOCKING CRITICAL PROBE-CRIT-1"
assemble --set sast=sarif-medium.sarif; gate; expect_pass "4b nonblocking finding passes"
if python3 -I - "$WORK/reports/findings/sast.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
item = doc["nonBlocking"][0]
print("      recorded: %s owner=%s due=%s" % (item["rule"], item["owner"], item["due"]))
sys.exit(0 if item["owner"] and item["due"] else 1)
PY
then echo "PASS  4b nonblocking finding is recorded with owner and due date"; else echo "FAIL  4b no owner and due date recorded"; FAILED=$((FAILED + 1)); fi
assemble --set secrets=sarif-secret.sarif; gate; expect_fail "4c a leaked secret" "secrets.*BLOCKING .* probe-secret-1"
python3 -I -c "
import datetime, json, sys
exp = (datetime.date.today() + datetime.timedelta(days=7)).isoformat()
json.dump({'dispositions': [{'match': 'probe-secret-1', 'reason': 'probe', 'owner': 'probe', 'expires': exp}]}, open(sys.argv[1], 'w'))
" "$WORK/dismiss.json"
assemble --set secrets=sarif-secret.sarif; gate workflow-complete.yml --dispositions "$WORK/dismiss.json"; expect_fail "4d a secret cannot be dismissed by a disposition" "secrets.*BLOCKING .* probe-secret-1"
assemble --wrong-sha unit-ci; gate; expect_fail "5a report for the wrong commit" "unit-ci.*wrong commit"
assemble --stale sast; gate; expect_fail "5b report older than the commit (stale)" "sast.*stale"
assemble --delete-report lint; gate; expect_fail "5d summary report (lint) missing" "lint.*report file 'lint/summary.json' is missing"
assemble --tamper lint; gate; expect_fail "5e summary report (lint) changed after its wrapper wrote it" "lint.*does not match the hash"
assemble --stale types; gate; expect_fail "5f summary report (types) stale" "types.*stale"
assemble --tamper sast; gate; expect_fail "5c report changed after its wrapper wrote it" "sast.*does not match the hash"
assemble; gate workflow-missing-job.yml; expect_fail "6a workflow edit removes a required job" "workflow.*required job\(s\) missing: security"
assemble; gate workflow-unpinned.yml; expect_fail "6b workflow edit unpins an action" "workflow.*unpinned action"

echo "== layer probes (ARCHITECTURE section 1.4)"
layer_probe() { # fixture rule
  LAYERS_ROOT="$HERE/layers/$1" CI_REPORTS_DIR="$WORK/layer-reports" "$ROOT/scripts/ci/layers.sh" >"$GATE_OUT" 2>&1
  local rc=$?
  if [ "$1" = clean ]; then
    if [ "$rc" -eq 0 ]; then printf 'PASS  %-58s layers exit 0: %s\n' "L0 clean fixture tree passes" "$(tail -1 "$GATE_OUT")"
    else printf 'FAIL  clean fixture tree must pass (exit %s)\n' "$rc"; cat "$GATE_OUT"; FAILED=$((FAILED + 1)); fi
  elif [ "$rc" -ne 0 ] && grep -q "VIOLATION $2:" "$GATE_OUT"; then
    printf 'PASS  %-58s layers exit %s: %s\n' "$3" "$rc" "$(grep -m1 "VIOLATION $2:" "$GATE_OUT" | cut -c1-150)"
  else
    printf 'FAIL  %-58s expected rule %s (exit %s)\n' "$3" "$2" "$rc"; cat "$GATE_OUT"; FAILED=$((FAILED + 1))
  fi
}
layer_probe clean "" ""
layer_probe upward-import no-upward-module-import "L1 upward import (production imports lifecycle)"
layer_probe deep-import no-deep-import "L2 deep import into another module's repository"
layer_probe unsealer-in-api unsealer-worker-only "L3 api-process file imports key-unsealer.ts"
layer_probe platform-cycle no-cycles "L4 cycle between two platform packages"
layer_probe web-imports-api web-no-api "L5 apps/web imports apps/api"

echo "== real tree"
"$ROOT/scripts/ci/layers.sh" >"$GATE_OUT" 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then echo "PASS  real tree passes layers.sh: $(tail -1 "$GATE_OUT")"; else echo "FAIL  real tree layers.sh exit $rc"; cat "$GATE_OUT"; FAILED=$((FAILED + 1)); fi

if [ "$FAILED" -eq 0 ]; then echo "ALL PROBES BEHAVED AS EXPECTED"; exit 0; fi
echo "$FAILED PROBE(S) DID NOT BEHAVE"; exit 1
