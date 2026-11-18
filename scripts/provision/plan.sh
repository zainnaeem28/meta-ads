#!/usr/bin/env bash
# Provisioning plan check (DO-11, TASK-018). The one required check of the ticket.
#   scripts/provision/plan.sh --check [--junit FILE] [--record FILE]   run everything with no credential (see plan-check.mjs)
#   scripts/provision/plan.sh --write                                  regenerate infra/render/<env>/render.yaml
# Exit 0 only when every check passed; 2 on a usage error. Needs node, psql and the shared test PostgreSQL (PROVISION_PG_ADMIN_URL).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
mode="${1:-}"; shift || true
case "$mode" in
  --check)
    junit="$ROOT/reports/provision/junit.xml"
    args=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --junit) junit="$(realpath -m "$2")"; shift 2 ;;
        --record) args+=(--record "$(realpath -m "$2")"); shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
      esac
    done
    command -v node >/dev/null && command -v "${PSQL_BIN:-psql}" >/dev/null || { echo "plan: node and psql are required" >&2; exit 2; }
    exec node "$HERE/plan-check.mjs" --junit "$junit" "${args[@]}"
    ;;
  --write) exec node "$HERE/render-blueprint.mjs" --write ;;
  *) echo "usage: plan.sh --check [--junit FILE] [--record FILE] | --write" >&2; exit 2 ;;
esac
