#!/usr/bin/env bash
# Dependency scan: osv-scanner over pnpm-lock.yaml, with pnpm audit as the second source.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need_tool osv-scanner
mkdir -p "$REPORTS"
rc=0
OK_CODES="0 1" scan deps osv-scanner deps.sarif "" \
  osv-scanner scan source --lockfile pnpm-lock.yaml --format sarif --output-file "$REPORTS/deps.sarif" || rc=$?
arc=0
OK_CODES="0 1" scan deps-audit "pnpm audit" audit.json "" \
  bash -c "pnpm audit --json > '$REPORTS/audit.json'" || arc=$?
[ "$rc" -eq 0 ] && [ "$arc" -eq 0 ]
