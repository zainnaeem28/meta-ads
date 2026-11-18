#!/usr/bin/env bash
# Scan a built web bundle for secrets: bundle-scan.sh [DIR] [REPORT.sarif]. Exit 1 on any finding, 2 on a tool
# failure or a missing/empty directory. Default DIR is apps/web/.next; with no build present it says so and exits 3
# (not applicable), never 0.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export PATH="${CI_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/shroomap-ci-tools}/bin:$PATH"
dir="${1:-$ROOT/apps/web/.next}"
report="${2:-$ROOT/reports/bundle-secrets.sarif}"
if [ ! -d "$dir" ]; then echo "bundle-scan: no built bundle at $dir" >&2; exit 3; fi
[ -n "$(find "$dir" -type f -print -quit)" ] || { echo "bundle-scan: $dir is empty" >&2; exit 2; }
mkdir -p "$(dirname "$report")"
rm -f "$report"
rc=0
gitleaks dir --config "$ROOT/config/gitleaks.toml" --report-format sarif --report-path "$report" \
  --redact --no-banner --exit-code 1 "$dir" || rc=$?
[ -s "$report" ] || { echo "bundle-scan: gitleaks wrote no report (exit $rc)" >&2; exit 2; }
case "$rc" in 0|1) exit "$rc" ;; *) exit 2 ;; esac
