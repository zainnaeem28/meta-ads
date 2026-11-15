#!/usr/bin/env bash
# ESLint (import-boundary rules) and Prettier over the whole repository.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_summary lint "eslint+prettier" bash -c "pnpm lint && pnpm format:check"
