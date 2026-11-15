#!/usr/bin/env bash
# API, worker and database tests against the shared test PostgreSQL (a uniquely named database per run).
# Runs the foundation database and slice suites and merges their JUnit files into one report.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
out="$REPORTS/integration"
mkdir -p "$out" "$REPORTS/foundation"
rm -f "$out/junit.xml" "$REPORTS"/foundation/*.xml
rc=0
for script in test:db test:slices-a test:slices-b; do
  pnpm -r --if-present "$script" || rc=$?
done
python3 -I - "$REPORTS/foundation" "$out/junit.xml" <<'PY' || rc=$?
import glob, sys, xml.etree.ElementTree as ET
src, dest = sys.argv[1], sys.argv[2]
root = ET.Element("testsuites")
files = sorted(glob.glob(src + "/*.xml"))
if not files:
    sys.exit("no integration JUnit file was written")
for f in files:
    for suite in ET.parse(f).getroot().iter("testsuite"):
        root.append(suite)
ET.ElementTree(root).write(dest, encoding="utf-8", xml_declaration=True)
PY
if [ "$rc" -eq 0 ]; then record integration junit pass "vitest" 0 integration/junit.xml
else record integration junit fail "vitest" "$rc" integration/junit.xml "integration suites exited $rc"; fi
exit "$rc"
