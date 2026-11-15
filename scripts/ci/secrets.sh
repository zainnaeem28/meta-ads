#!/usr/bin/env bash
# Gitleaks over the ticket's commit range (origin/dev..HEAD) or the full history when there is no range.
# Every finding blocks, whatever its severity. Values are redacted in the report.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need_tool gitleaks
mkdir -p "$REPORTS"
range="${CI_SECRETS_RANGE:-}"
if [ -z "$range" ] && git rev-parse --verify -q origin/dev >/dev/null && [ -z "${CI_SECRETS_FULL:-}" ]; then
  range="origin/dev..HEAD"
fi
log_opts=()
[ -n "$range" ] && log_opts=(--log-opts="$range")
OK_CODES="0 1" scan secrets gitleaks secrets.sarif --secrets \
  gitleaks git --config "$CI_DIR/gitleaks.toml" --report-format sarif --report-path "$REPORTS/secrets.sarif" \
  --redact --no-banner --exit-code 1 "${log_opts[@]}" .
