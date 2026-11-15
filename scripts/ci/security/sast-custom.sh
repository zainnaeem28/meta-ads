#!/usr/bin/env bash
# The ticket SAST run: the baseline rules plus the custom key-custody, egress, SQL and process rules in
# config/semgrep. Same wrapper contract as scripts/ci/sast.sh (writes reports/sast.sarif and the meta file,
# judged by the findings policy). Rule fixtures are excluded; run-fixtures.sh proves them separately.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need_tool semgrep
mkdir -p "$REPORTS"
# SAST_TARGETS and SAST_INCLUDE_FIXTURES exist for run-fixtures.sh, which points this wrapper at the rule fixtures.
read -r -a targets <<<"${SAST_TARGETS:-apps packages tools scripts}"
excludes=(--exclude node_modules --exclude reports --exclude scripts/ci/probes --exclude docs)
[ -n "${SAST_INCLUDE_FIXTURES:-}" ] || excludes+=(--exclude scripts/ci/security/fixtures)
OK_CODES="0" scan sast semgrep sast.sarif "" \
  semgrep scan --config "$CI_DIR/semgrep/rules.yml" --config "$CI_ROOT/config/semgrep" --sarif --output "$REPORTS/sast.sarif" \
  --metrics off --disable-version-check --quiet "${excludes[@]}" "${targets[@]}"
