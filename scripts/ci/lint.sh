#!/usr/bin/env bash
# ESLint (import-boundary rules), Prettier over the whole repository, and the database lint (no schema push,
# provider_keys column projections, migration names) with a negative probe: the lint must fail a tree with a forbidden schema push.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LINT_DB="$(dirname "${BASH_SOURCE[0]}")/lint-db.sh"
export LINT_DB
lint_db_with_probe() {
  bash "$LINT_DB" || return 1
  local probe
  probe="$(mktemp -d)"
  local tool=drizzle-kit verb=push
  printf "pnpm exec %s %s\n" "$tool" "$verb" > "$probe/bad.sh"
  if LINT_ROOT="$probe" bash "$LINT_DB" > /dev/null; then
    echo "lint-db negative probe: a tree with a schema push passed the lint" >&2
    rm -rf "$probe"
    return 1
  fi
  rm -rf "$probe"
  echo "lint-db negative probe: a tree with a schema push is rejected"
}

run_summary lint "eslint+prettier+lint-db" bash -c "pnpm lint && pnpm format:check && $(declare -f lint_db_with_probe); lint_db_with_probe"
