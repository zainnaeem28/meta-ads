#!/usr/bin/env bash
# Semgrep with the pinned rule set in scripts/ci/semgrep/ (no registry fetch at run time).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need_tool semgrep
mkdir -p "$REPORTS"
OK_CODES="0" scan sast semgrep sast.sarif "" \
  semgrep scan --config "$CI_DIR/semgrep/rules.yml" --sarif --output "$REPORTS/sast.sarif" \
  --metrics off --disable-version-check --quiet \
  --exclude node_modules --exclude reports --exclude scripts/ci/probes --exclude docs \
  apps packages tools scripts
