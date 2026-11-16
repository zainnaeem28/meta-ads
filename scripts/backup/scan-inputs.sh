#!/usr/bin/env bash
# Trivy scan of everything that goes into the `backup` image, for runners without a Docker daemon: the exact
# `pnpm deploy` payload the Dockerfile copies (dependencies and secrets) and the Dockerfile itself (misconfiguration).
# Writes reports/container.sarif. This stands in for the image scan of scripts/ci/container-scan.sh, which needs a
# daemon to build and scan the image; with one, that script (CONTAINER_TARGETS=backup) is the authoritative scan.
# The OS packages the image adds (postgresql-client, age) are only covered by the image scan.
source "$(dirname "${BASH_SOURCE[0]}")/../ci/lib.sh"
need_tool trivy
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pnpm --filter backup deploy --prod --legacy "$work/backup" >/dev/null
mkdir -p "$REPORTS"
trivy fs --format sarif --output "$work/payload.sarif" --quiet --scanners vuln,secret \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL "$work/backup"
trivy config --format sarif --output "$work/dockerfile.sarif" --quiet \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL "$CI_ROOT/docker/Dockerfile"
python3 -I - "$work" "$REPORTS/container.sarif" <<'PY'
import json, sys
work, out = sys.argv[1], sys.argv[2]
merged = {"version": "2.1.0", "$schema": "https://json.schemastore.org/sarif-2.1.0.json", "runs": []}
for name in ("payload", "dockerfile"):
    for run in json.load(open(f"{work}/{name}.sarif"))["runs"]:
        run.setdefault("automationDetails", {})["id"] = f"container/backup-{name}"
        merged["runs"].append(run)
json.dump(merged, open(out, "w"))
PY
python3 -I -c "
import json, sys
doc = json.load(open(sys.argv[1]))
print('container.sarif: %d runs, %d results' % (len(doc['runs']), sum(len(r.get('results', [])) for r in doc['runs'])))" "$REPORTS/container.sarif"
