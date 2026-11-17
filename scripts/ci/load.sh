#!/usr/bin/env bash
# k6 at the scaled-down NFR-01 target against the baseline stack (tests/baselines/stack.mjs). Pass conditions and
# the load shape come from config/quality-policy.json (baselines.load). Writes reports/baselines/load.json.
# Usage: load.sh --scaled            the policy's target (1 min ramp, 10 min steady)
#        load.sh --smoke             a 30 s run to prove the script executes; recorded, never counted as the baseline
#        load.sh --scaled --invalid-session   negative test: the run must be rejected (sessions refused with 401)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
BL="$CI_ROOT/tests/baselines"
mode=scaled; invalid=0
for arg in "$@"; do
  case "$arg" in
    --scaled) mode=scaled ;; --smoke) mode=smoke ;; --invalid-session) invalid=1 ;;
    *) echo "load.sh: unknown argument $arg" >&2; exit 2 ;;
  esac
done
out="$REPORTS/baselines"; state="$out/state-load"
mkdir -p "$out"
need_baseline_tools() { "$BL/install-tools.sh" "$@" >&2; }
[ -x "$CI_TOOLS_DIR/bin/k6" ] || need_baseline_tools k6
K6_VERSION="$("$CI_TOOLS_DIR/bin/k6" version | head -1 | sed -E 's/k6 v?([0-9.]+).*/\1/')"; export K6_VERSION

pol() { node "$BL/lib/policy.mjs" baselines "$1"; }
ramp="$(pol load.rampSec)"; steady="$(pol load.steadySec)"
if [ "$mode" = smoke ]; then ramp=10; steady=20; fi

node "$BL/lib/results.mjs" reset load
pids=()
cleanup() { for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; node "$BL/stack.mjs" down --state "$state" >&2 || true; }
trap cleanup EXIT
node "$BL/stack.mjs" up --state "$state"
if [ "$invalid" = 1 ]; then
  # negative test: every token is replaced by one the api cannot verify, so every request is answered 401
  python3 -I -c "
import json, sys
p = sys.argv[1]; s = json.load(open(p))
for u in s['users'] + [s['admin']]: u['token'] = 'not.a.token'
json.dump(s, open(p, 'w'))" "$state/state.json"
fi

node "$BL/load/pool-sampler.mjs" "$state/state.json" "$out/load-pool.json" &
pids+=($!)
sleep 2
api_url="$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['apiUrl'])" "$state/state.json")"
rc=0
"$CI_TOOLS_DIR/bin/k6" run --quiet --no-usage-report \
  -e API_URL="$api_url" -e STATE_FILE="$state/state.json" -e SUMMARY_FILE="$out/load-summary.json" \
  -e VUS="$(pol load.virtualUsers)" -e RAMP_SEC="$ramp" -e STEADY_SEC="$steady" -e THINK_SEC="$(pol load.thinkTimeSec)" \
  -e POLL_SEC="$(pol load.pollIntervalSec)" -e READ_SHARE="$(pol load.readShare)" \
  "$BL/load/scaled.js" || rc=$?
kill "${pids[0]}" 2>/dev/null || true; wait "${pids[0]}" 2>/dev/null || true; pids=()
if [ ! -s "$out/load-summary.json" ]; then echo "k6 wrote no summary (exit $rc)" >&2; node "$BL/lib/results.mjs" add load "k6 ran" fail "k6 exited $rc without a summary"; exit 1; fi
flag=(); [ "$mode" = smoke ] && flag=(--smoke)
node "$BL/load/evaluate.mjs" "$out/load-summary.json" "$out/load-pool.json" "$out/load.json" "${flag[@]}"
