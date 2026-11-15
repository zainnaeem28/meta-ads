#!/usr/bin/env bash
# The ticket secret scan: gitleaks with config/gitleaks.toml over origin/dev..HEAD (or the full history when
# CI_SECRETS_FULL=1 or there is no origin/dev), then the built web bundle when one exists. Every finding blocks.
# Same wrapper contract as scripts/ci/secrets.sh (writes reports/secrets.sarif and the meta file).
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need_tool gitleaks
mkdir -p "$REPORTS"
range="${CI_SECRETS_RANGE:-}"
if [ -z "$range" ] && git rev-parse --verify -q origin/dev >/dev/null && [ -z "${CI_SECRETS_FULL:-}" ]; then
  range="origin/dev..HEAD"
fi
log_opts=()
[ -n "$range" ] && log_opts=(--log-opts="$range")
OK_CODES="0 1" scan secrets gitleaks secrets.sarif --secrets \
  gitleaks git --config "$CI_ROOT/config/gitleaks.toml" --report-format sarif --report-path "$REPORTS/secrets.sarif" \
  --redact --no-banner --exit-code 1 "${log_opts[@]}" "${SECRETS_REPO:-.}"
