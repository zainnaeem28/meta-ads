#!/usr/bin/env bash
# Migration check harness (TC-OPS-03, TC-NFR-05; ARCHITECTURE 2.7-2.9): the whole history on an empty database, the
# previous release's snapshot plus synthetic data upgraded, the compensating-migration rollback check on a copy, the seed
# rerun, the grants check and the expand/contract rule, on the shared test PostgreSQL (unique database names, dropped
# afterwards). The negative probes run in the same suite. JUnit: apps/api/reports/migcheck/junit.xml (the gate reads it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
api="$CI_ROOT/apps/api"
rm -f "$api"/reports/migcheck/junit.xml "$api"/reports/migcheck/lcov.info
rc=0
(cd "$api" && pnpm exec vitest run --config tests/integration/migrations-check/vitest.config.ts) || rc=$?
if [ "$rc" -eq 0 ]; then record db-check-history junit pass "vitest" 0 ../apps/api/reports/migcheck/junit.xml
else record db-check-history junit fail "vitest" "$rc" ../apps/api/reports/migcheck/junit.xml "db:check-history exited $rc"; fi
exit "$rc"
