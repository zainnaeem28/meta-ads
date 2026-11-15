#!/usr/bin/env bash
# API contract check (OpenAPI lint, generated-types drift, envelope and error registry tests).
# TASK-019 replaces the body below with the real check. Until packages/contracts holds openapi.yaml this is
# a stub that exits 0 with a notice; the gate accepts the stub only for the TASK-019 window.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ ! -f "$CI_ROOT/packages/contracts/openapi.yaml" ]; then
  echo "NOTICE: packages/contracts has no openapi.yaml yet; contract check is a stub until TASK-019" >&2
  record contract summary stub "contract-stub" 0 "" "stub until TASK-019 replaces this body"
  exit 0
fi
echo "contract.sh: packages/contracts/openapi.yaml exists but the real check (TASK-019) is not installed" >&2
record contract summary fail "contract-stub" 1 "" "real contract check missing"
exit 1
