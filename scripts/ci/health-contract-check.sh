#!/usr/bin/env bash
# API-900/API-901 contract in CI (DEVOPS-PLAN 11.1, TASK-010): build the api, start the built entry point against a
# throwaway database on the shared test PostgreSQL, validate both health answers against HealthResponse of the OpenAPI
# file, then check the 503 and drain behaviour the uptime probes depend on. Output goes to reports/health-contract/.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
mkdir -p "$REPORTS/health-contract"
steps() {
  pnpm --filter @shroomap/api build
  node "$CI_ROOT/scripts/monitor/src/health-contract.ts"
}
run_summary health-contract node steps
