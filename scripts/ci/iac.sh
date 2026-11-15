#!/usr/bin/env bash
# Trivy config scan of Dockerfiles, Compose, infra and CI workflows. Not applicable until one exists.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
found=0
for p in docker infra Dockerfile docker-compose.yml compose.yaml .github/workflows; do [ -e "$p" ] && found=1; done
if [ "$found" -eq 0 ]; then not_applicable iac findings "no Dockerfile, Compose, infra or workflow files yet"; exit 0; fi
need_tool trivy
mkdir -p "$REPORTS"
OK_CODES="0" scan iac trivy iac.sarif "" \
  trivy config --format sarif --output "$REPORTS/iac.sarif" --exit-code 0 --quiet \
  --skip-dirs node_modules --skip-dirs reports --skip-dirs scripts/ci/probes "${IAC_ROOT:-.}"
