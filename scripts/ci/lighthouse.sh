#!/usr/bin/env bash
# Lighthouse CI and Playwright web-vitals on the built web app (mobile and desktop, SAMPLES per route and profile,
# medians compared) for the eight key pages. Budgets, routes and sample count come from config/quality-policy.json
# (baselines.frontend). Writes reports/baselines/frontend.json. Performance runs get the host to themselves: they run
# after the stack is up and nothing else is started by this wrapper.
# Usage: lighthouse.sh            the first baseline: a budget breach is recorded and filed as a product defect, the run
#                                 still succeeds; an invalid run (too few samples, redirected to sign-in) fails
#        lighthouse.sh --enforce  gate mode (QA on the final candidate): any budget breach fails
#        lighthouse.sh --smoke   one sample per route, recorded, not a baseline
#        lighthouse.sh --invalid-session   negative test: the signed-in routes redirect to sign-in and the run must fail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
BL="$CI_ROOT/tests/baselines"
smoke=0; invalid=0; enforce=()
for arg in "$@"; do
  case "$arg" in
    --enforce) enforce=(--enforce) ;; --smoke) smoke=1 ;; --invalid-session) invalid=1 ;;
    *) echo "lighthouse.sh: unknown argument $arg" >&2; exit 2 ;;
  esac
done
out="$REPORTS/baselines"; state="$out/state-frontend"
mkdir -p "$out"
[ -x "$CI_TOOLS_DIR/lighthouse/node_modules/.bin/lighthouse" ] || "$BL/install-tools.sh" lighthouse >&2
"$BL/install-tools.sh" chromium >&2
cleanup() { node "$BL/stack.mjs" down --state "$state" >&2 || true; }
trap cleanup EXIT
node "$BL/stack.mjs" up --state "$state"
if [ "$invalid" = 1 ]; then
  python3 -I -c "
import json, sys
p = sys.argv[1]; s = json.load(open(p))
for u in s['users'] + [s['admin']]: u['cookie'] = 'forged.cookie'
json.dump(s, open(p, 'w'))" "$state/state.json"
fi
samples="$(node "$BL/lib/policy.mjs" baselines frontend.samplesPerRoute)"
[ "$smoke" = 1 ] && samples=1
node "$BL/frontend/lighthouse-run.mjs" --state "$state/state.json" --out "$out/lighthouse-samples.json" --samples "$samples"
node "$BL/frontend/web-vitals.mjs" --state "$state/state.json" --out "$out/web-vitals-samples.json" --samples "$samples"
node "$BL/frontend/evaluate.mjs" "$out/lighthouse-samples.json" "$out/web-vitals-samples.json" "$out/frontend.json" "${enforce[@]}"
