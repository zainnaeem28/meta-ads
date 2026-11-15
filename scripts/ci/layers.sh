#!/usr/bin/env bash
# Layer boundary check: dependency-cruiser with the layer table and the five rules of ARCHITECTURE 1.4.
# LAYERS_ROOT points the check at another source tree (the negative probes use fixture trees).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ROOT="${LAYERS_ROOT:-$CI_ROOT}"
mkdir -p "$REPORTS/layers"
rc=0
( cd "$ROOT" && "$CI_ROOT/node_modules/.bin/depcruise" apps --config "$CI_ROOT/.dependency-cruiser.cjs" \
    --output-type json ) >"$REPORTS/layers/depcruise.json" 2>"$REPORTS/layers/stderr.log" || rc=$?
cat "$REPORTS/layers/stderr.log" >&2
violations="$(python3 -I -c "
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
except Exception as err:
    print(\"unreadable depcruise report: %s\" % err); sys.exit(3)
bad = [v for v in doc[\"summary\"][\"violations\"] if v[\"rule\"][\"severity\"] == \"error\"]
for v in bad:
    print(\"VIOLATION %s: %s -> %s\" % (v[\"rule\"][\"name\"], v[\"from\"], v[\"to\"]))
print(\"layers: %d modules, %d violations\" % (doc[\"summary\"][\"totalCruised\"], len(bad)))
sys.exit(1 if bad else 0)
" "$REPORTS/layers/depcruise.json")" && vrc=0 || vrc=$?
echo "$violations" | tee "$REPORTS/layers/summary.txt"
python3 -I -c "
import json, sys
json.dump({\"id\": \"layers\", \"tool\": \"dependency-cruiser\", \"depcruiseExit\": int(sys.argv[1]),
           \"violationExit\": int(sys.argv[2]), \"sourceSha\": sys.argv[3]}, open(sys.argv[4], \"w\"), indent=2)
" "$rc" "$vrc" "$SOURCE_SHA" "$REPORTS/layers/summary.json"
if [ "$rc" -ne 0 ] && [ "$vrc" -eq 0 ]; then vrc=$rc; fi
if [ "$vrc" -eq 0 ]; then record layers summary pass dependency-cruiser 0 layers/summary.json
else record layers summary fail dependency-cruiser "$vrc" layers/summary.json "layer boundary violations or tool failure"; fi
exit "$vrc"
