#!/usr/bin/env bash
# Run submit_check.py with the standard checks and report flags, calling the same wrappers the release
# pipeline calls. SUBMIT_CHECK points at submit_check.py (default: $AGENT_HOME/submit_check.py).
# Usage: submit-check.sh [--base REF] [--evidence FILE]... [extra submit_check.py options]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../.."
SUBMIT_CHECK="${SUBMIT_CHECK:-${AGENT_HOME:-}/submit_check.py}"
[ -f "$SUBMIT_CHECK" ] || { echo "set SUBMIT_CHECK to submit_check.py" >&2; exit 2; }
export CI=1
exec python3 "$SUBMIT_CHECK" --base "${CI_BASE:-origin/dev}" \
  --check "scripts/ci/lint.sh" --check "scripts/ci/types.sh" --check "scripts/ci/layers.sh" \
  --check "scripts/ci/unit.sh ci" --check "scripts/ci/contract.sh" \
  --check "scripts/ci/sast.sh" --check "scripts/ci/deps.sh" --check "scripts/ci/secrets.sh" \
  --check "scripts/ci/probes/run-all.sh" \
  --junit reports/ci/junit.xml --coverage reports/ci/lcov.info:lines=80,branches=75 \
  --findings reports/sast.sarif --findings reports/deps.sarif --findings reports/audit.json \
  --secrets reports/secrets.sarif --dispositions config/dispositions.json "$@"
