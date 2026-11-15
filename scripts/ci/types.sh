#!/usr/bin/env bash
# Strict type check of every workspace package and the foundation tests.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_summary types "tsc" pnpm typecheck
