#!/usr/bin/env bash
# Unit suites with JUnit and lcov coverage. One suite per call (default: ci, the CI tooling's own tests).
# Usage: unit.sh [suite]. Later tickets register their workspace suites in the case below and in the policy.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
suite="${1:-ci}"
case "$suite" in
  ci)
    need_tool coverage python
    out="$REPORTS/ci"
    mkdir -p "$out"
    rm -f "$out/junit.xml" "$out/lcov.info" "$out/.coverage"
    rc=0
    COVERAGE_FILE="$out/.coverage" python3 -I -m coverage run --branch --source=scripts/ci \
      --omit='*/tests/*,*/probes/*' -m pytest scripts/ci/tests -q -p no:cacheprovider \
      --junitxml="$out/junit.xml" || rc=$?
    COVERAGE_FILE="$out/.coverage" python3 -I -m coverage lcov -o "$out/lcov.info" --omit='*/tests/*,*/probes/*' || rc=$?
    COVERAGE_FILE="$out/.coverage" python3 -I -m coverage report --omit='*/tests/*,*/probes/*' || true
    if [ "$rc" -eq 0 ]; then record unit-ci junit pass "pytest+coverage" 0 ci/junit.xml
    else record unit-ci junit fail "pytest+coverage" "$rc" ci/junit.xml "unit suite exited $rc"; fi
    exit "$rc"
    ;;
  *)
    echo "unknown unit suite '$suite'" >&2
    exit 2
    ;;
esac
