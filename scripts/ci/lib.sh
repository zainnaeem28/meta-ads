#!/usr/bin/env bash
# Shared helpers for the scripts/ci wrappers. Source it; never run it.
# Every wrapper writes its report under reports/ and a meta file under reports/meta/ that the quality gate
# reads back from disk. A wrapper exits non-zero when the tool fails or its findings block.
set -euo pipefail

CI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI_DIR="$CI_ROOT/scripts/ci"
export CI_TOOLS_DIR="${CI_TOOLS_DIR:-$HOME/.cache/shroomap-ci-tools}"
export PATH="$CI_TOOLS_DIR/bin:$CI_TOOLS_DIR/venv/bin:$PATH"
REPORTS="${CI_REPORTS_DIR:-$CI_ROOT/reports}"
POLICY="${CI_POLICY:-$CI_ROOT/config/quality-policy.json}"
DISPOSITIONS="${CI_DISPOSITIONS:-$CI_ROOT/config/dispositions.json}"
cd "$CI_ROOT"
SOURCE_SHA="$(python3 -I -c "import sys; sys.path.insert(0, sys.argv[1]); import ci_reports; print(ci_reports.source_sha(sys.argv[2]))" "$CI_DIR" "$CI_ROOT")"

# need_tool NAME [installer-target]: make sure NAME is on PATH, installing the pinned version once if allowed.
need_tool() {
  command -v "$1" >/dev/null 2>&1 && return 0
  if [ "${CI_AUTO_INSTALL:-1}" = "1" ]; then
    "$CI_DIR/install-tools.sh" "${2:-$1}" >&2
  fi
  command -v "$1" >/dev/null 2>&1 || { echo "required tool '$1' is not installed (scripts/ci/install-tools.sh)" >&2; return 1; }
}

# record ID KIND STATUS TOOL EXIT [REPORT] [REASON]: write the meta file next to the reports.
record() {
  python3 -I "$CI_DIR/ci_reports.py" write "$REPORTS" "$1" "$2" "$3" "$SOURCE_SHA" "$4" "$5" "${6:-}" "${7:-}"
}

# run_summary ID TOOL CMD...: run CMD, keep its output, write reports/ID/summary.json and the meta file.
run_summary() {
  local id="$1" tool="$2"; shift 2
  mkdir -p "$REPORTS/$id"
  local rc=0
  set +e
  "$@" 2>&1 | tee "$REPORTS/$id/output.log"
  rc="${PIPESTATUS[0]}"
  set -e
  python3 -I -c "
import json, sys
json.dump({'id': sys.argv[1], 'tool': sys.argv[2], 'command': sys.argv[3], 'exitCode': int(sys.argv[4]),
           'sourceSha': sys.argv[5]}, open(sys.argv[6], 'w'), indent=2)
" "$id" "$tool" "$*" "$rc" "$SOURCE_SHA" "$REPORTS/$id/summary.json"
  if [ "$rc" -eq 0 ]; then
    record "$id" summary pass "$tool" 0 "$id/summary.json"
  else
    record "$id" summary fail "$tool" "$rc" "$id/summary.json" "$* exited $rc"
  fi
  return "$rc"
}

# not_applicable ID KIND REASON: nothing to check yet; the gate re-verifies that claim against the tree.
not_applicable() {
  record "$1" "$2" not_applicable none 0 "" "$3"
  echo "$1: not applicable: $3"
}

# evaluate ID REPORT [--secrets]: apply the findings policy, write reports/findings/ID.json, return its exit code.
evaluate() {
  local id="$1" report="$2"; shift 2
  mkdir -p "$REPORTS/findings"
  python3 -I "$CI_DIR/evaluate_findings.py" "$report" --policy "$POLICY" --dispositions "$DISPOSITIONS" \
    --out "$REPORTS/findings/$id.json" "$@"
}

# scan ID TOOL REPORT-RELATIVE KIND-FLAG CMD...: run a scanner whose own exit code means "crashed or ran",
# then judge the report. A tool crash (exit not in OK_CODES) is a tool failure; blocking findings fail too.
scan() {
  local id="$1" tool="$2" report="$3" flag="$4"; shift 4
  mkdir -p "$(dirname "$REPORTS/$report")"
  rm -f "$REPORTS/$report"
  local rc=0
  "$@" || rc=$?
  case " ${OK_CODES:-0} " in
    *" $rc "*) ;;
    *) record "$id" findings fail "$tool" "$rc" "" "$tool exited $rc"; echo "$tool failed with exit $rc" >&2; return 1 ;;
  esac
  if [ ! -s "$REPORTS/$report" ]; then
    record "$id" findings fail "$tool" "$rc" "" "$tool wrote no report"; echo "$tool wrote no report" >&2; return 1
  fi
  local erc=0
  evaluate "$id" "$REPORTS/$report" $flag || erc=$?
  local kind=findings; [ -n "$flag" ] && kind=secrets
  if [ "$erc" -eq 0 ]; then record "$id" "$kind" pass "$tool" 0 "$report"
  else record "$id" "$kind" fail "$tool" "$erc" "$report" "blocking findings or a tool failure"; fi
  return "$erc"
}
