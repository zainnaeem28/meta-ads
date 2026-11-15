#!/usr/bin/env bash
# Playwright journeys against the built stack. Not applicable until a Playwright config exists.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
config=""
for candidate in playwright.config.ts apps/web/playwright.config.ts; do [ -f "$candidate" ] && config="$candidate"; done
if [ -z "$config" ]; then not_applicable e2e junit "no playwright.config.ts yet"; exit 0; fi
out="$REPORTS/e2e"
mkdir -p "$out"
rc=0
PLAYWRIGHT_JUNIT_OUTPUT_FILE="$out/junit.xml" pnpm exec playwright test --config "$config" --reporter=junit || rc=$?
if [ "$rc" -eq 0 ]; then record e2e junit pass playwright 0 e2e/junit.xml
else record e2e junit fail playwright "$rc" e2e/junit.xml "playwright exited $rc"; fi
exit "$rc"
