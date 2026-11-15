#!/usr/bin/env bash
# Stub host adapter (SAR-DOP-13). Records every call into a file and mutates nothing: no network, no credential.
# Usage: stub.sh OP [ARG...]
# Environment: STUB_CALLS_FILE (required), STUB_FAIL_OPS=op1,op2 (those ops exit 1), STUB_SLEEP_OPS=op=seconds,...
set -euo pipefail

op="${1:-}"
[ -n "$op" ] || { echo "stub: no operation given" >&2; exit 64; }
shift
calls="${STUB_CALLS_FILE:-}"
[ -n "$calls" ] || { echo "stub: STUB_CALLS_FILE is not set" >&2; exit 64; }

mkdir -p "$(dirname "$calls")"
printf '%s' "$op" >>"$calls"
for arg in "$@"; do printf ' %s' "$arg" >>"$calls"; done
printf '\n' >>"$calls"

IFS=, read -ra sleeps <<<"${STUB_SLEEP_OPS:-}"
IFS=, read -ra failures <<<"${STUB_FAIL_OPS:-}"
for pair in "${sleeps[@]}"; do
  if [ "${pair%%=*}" = "$op" ]; then sleep "${pair#*=}"; fi
done
for failing in "${failures[@]}"; do
  if [ "$failing" = "$op" ]; then echo "stub: $op failed (injected)" >&2; exit 1; fi
done

case "$op" in
  schema-version) echo "stub-schema-1" ;;
  backup) echo "stub-backup-1" ;;
  *) echo "stub: $op ok" ;;
esac
