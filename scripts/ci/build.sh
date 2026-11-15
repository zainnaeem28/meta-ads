#!/usr/bin/env bash
# Production build of every workspace package. Container images are built by the release pipeline
# (build once, deploy by digest) and described by reports/artifact.json when a Dockerfile exists.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_summary build "pnpm build" pnpm build
