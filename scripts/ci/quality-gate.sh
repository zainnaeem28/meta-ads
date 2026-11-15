#!/usr/bin/env bash
# Final gate: reads every report from disk and writes reports/quality.json.
# Usage: quality-gate.sh [--profile ticket|release] [extra quality_gate.py options]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
profile="${CI_PROFILE:-ticket}"
if [ "${1:-}" = "--profile" ]; then profile="$2"; shift 2; fi
exec python3 -I "$CI_DIR/quality_gate.py" --reports "$REPORTS" --profile "$profile" --policy "$POLICY" \
  --dispositions "$DISPOSITIONS" --sha "$SOURCE_SHA" --repo "$CI_ROOT" "$@"
