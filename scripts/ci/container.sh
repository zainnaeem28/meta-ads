#!/usr/bin/env bash
# Trivy image scan of the built image (CI_IMAGE_REF, a ref or an archive named by reports/artifact.json).
# Not applicable until the repository holds a Dockerfile.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ ! -d docker ] && [ ! -f Dockerfile ] && [ ! -f apps/api/Dockerfile ]; then
  not_applicable container findings "no Dockerfile or docker/ folder yet"; exit 0
fi
need_tool trivy
if [ -z "${CI_IMAGE_REF:-}" ]; then
  record container findings fail trivy 1 "" "no image to scan: set CI_IMAGE_REF to the built image"
  echo "container.sh: CI_IMAGE_REF is not set; run build first" >&2; exit 1
fi
mkdir -p "$REPORTS"
OK_CODES="0" scan container trivy container.sarif "" \
  trivy image --format sarif --output "$REPORTS/container.sarif" --exit-code 0 --quiet "$CI_IMAGE_REF"
