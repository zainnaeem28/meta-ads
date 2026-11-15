#!/usr/bin/env bash
# Builds each image target, runs the container smoke test (TC-OPS-01) and scans the exact image built with Trivy
# (vulnerabilities and secrets; Critical or High block, per config/quality-policy.json). Writes
# reports/container/junit.xml, reports/container.sarif and docs/evidence/TASK-008/digests.txt.
# Needs a Docker daemon: without one it fails (a scan that did not run is never a pass).
# Usage: container-scan.sh   (env: CONTAINER_TARGETS=api,worker,web, SMOKE_DB=host:port/database)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ -f docker/Dockerfile ] || { not_applicable container findings "no docker/Dockerfile yet"; exit 0; }
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  record container findings fail docker 1 "" "no Docker daemon: the images were not built or scanned"
  echo "container-scan.sh: a running Docker daemon is required to build and scan the images" >&2; exit 1
fi
need_tool trivy
targets="${CONTAINER_TARGETS:-api,worker,web}"
mkdir -p "$REPORTS/container"

smoke_rc=0
python3 -I docker/smoke/container_smoke.py --targets "$targets" --junit "${REPORTS#$CI_ROOT/}/container/junit.xml" \
  --ids "${REPORTS#$CI_ROOT/}/container/image-ids.json" || smoke_rc=$?
if [ "$smoke_rc" -ne 0 ]; then
  record container-smoke summary fail docker "$smoke_rc" container/junit.xml "container smoke test failed"; exit "$smoke_rc"
fi

rm -f "$REPORTS"/container/trivy-*.sarif
IFS=, read -ra list <<<"$targets"
for t in "${list[@]}"; do
  id="$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$REPORTS/container/image-ids.json" "$t")"
  trivy image --format sarif --output "$REPORTS/container/trivy-$t.sarif" --exit-code 0 --quiet \
    --scanners vuln,secret --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL "$id"
done
python3 -I - "$REPORTS" "${list[@]}" <<'PY'
import json, sys
reports, targets = sys.argv[1], sys.argv[2:]
merged = {"version": "2.1.0", "$schema": "https://json.schemastore.org/sarif-2.1.0.json", "runs": []}
for t in targets:
    doc = json.load(open(f"{reports}/container/trivy-{t}.sarif"))
    for run in doc["runs"]:
        run.setdefault("automationDetails", {})["id"] = f"container/{t}"
        merged["runs"].append(run)
json.dump(merged, open(f"{reports}/container.sarif", "w"))
PY
record container-smoke summary pass docker 0 container/junit.xml
erc=0
evaluate container "$REPORTS/container.sarif" || erc=$?
if [ "$erc" -eq 0 ]; then record container findings pass trivy 0 container.sarif
else record container findings fail trivy "$erc" container.sarif "blocking findings or a tool failure"; fi
exit "$erc"
