#!/usr/bin/env bash
# OWASP ZAP baseline (spider and passive scan, no active attack) against the baseline stack (tests/baselines/stack.mjs),
# once per context: anonymous, user and admin (a synthetic seeded session each). Contexts, session checks and the
# severity that blocks come from config/quality-policy.json (baselines.dast, failOn.sources.zap). Writes reports/zap.json.
# Usage: dast.sh --baseline   record the first baseline: findings are evaluated and reported, filed as defects, and do
#                             not fail the run; a run whose sessions were refused (mostly 401) always fails
#        dast.sh              gate mode (QA on the final candidate): any finding at or above the policy severity fails
#        dast.sh --smoke      shorter spider, same checks      dast.sh --invalid-session   negative test, must fail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
BL="$CI_ROOT/tests/baselines"
baseline=0; smoke=0; invalid=0
for arg in "$@"; do
  case "$arg" in
    --baseline) baseline=1 ;; --smoke) smoke=1 ;; --invalid-session) invalid=1 ;;
    *) echo "dast.sh: unknown argument $arg" >&2; exit 2 ;;
  esac
done
out="$REPORTS/baselines"; state="$out/state-dast"; zapdir="$out/zap"
mkdir -p "$out"; rm -rf "$zapdir"; mkdir -p "$zapdir"
[ -x "$CI_TOOLS_DIR/zap/ZAP_2.17.0/zap.sh" ] || "$BL/install-tools.sh" zap >&2
cleanup() { node "$BL/stack.mjs" down --state "$state" >&2 || true; }
trap cleanup EXIT
node "$BL/stack.mjs" up --state "$state"
if [ "$invalid" = 1 ]; then
  python3 -I -c "
import json, sys
p = sys.argv[1]; s = json.load(open(p))
for u in s['users'] + [s['admin']]: u['token'] = 'not.a.token'; u['cookie'] = 'forged.cookie'
json.dump(s, open(p, 'w'))" "$state/state.json"
fi
extra=(); [ "$smoke" = 1 ] && extra=(--smoke)
for context in $(node "$BL/lib/policy.mjs" baselines dast.contexts | python3 -I -c "import json,sys; print(' '.join(json.load(sys.stdin)))"); do
  node "$BL/dast/zap-run.mjs" --context "$context" --state "$state/state.json" --out "$zapdir" "${extra[@]}"
done
rc=0
node "$BL/dast/evaluate.mjs" "$zapdir" "$REPORTS/zap.json" || rc=$?
if [ "$rc" -ne 0 ]; then echo "dast: the sessions were not accepted; the run is not a baseline" >&2; exit 1; fi
erc=0
evaluate dast "$REPORTS/zap.json" || erc=$?
node "$BL/lib/results.mjs" add dast "ZAP findings below the policy severity (failOn.sources.zap)" "$([ "$erc" -eq 0 ] && echo pass || echo "$([ "$baseline" = 1 ] && echo skip || echo fail)")" "$(python3 -I -c "
import json, sys
r = json.load(open(sys.argv[1]))
print('%d blocking, %d non-blocking, %d dismissed' % (len(r['blocking']), len(r['nonBlocking']), len(r['dismissed'])))" "$REPORTS/findings/dast.json")"
if [ "$erc" -ne 0 ] && [ "$baseline" = 1 ]; then
  echo "dast: --baseline: blocking findings are recorded in $REPORTS/findings/dast.json and filed as product defects; not failing the baseline run" >&2
  exit 0
fi
exit "$erc"
