# TASK-048 evidence

- Unit and integration (`pnpm --filter @shroomap/api run lint`, `typecheck`, `test:unit`, `test:integration`) on real PostgreSQL; junit and lcov under `apps/api/reports/brief-data/`.
- `scripts/ci/layers.sh`, `scripts/ci/contract.sh`, `scripts/ci/rescan.sh --dry-run` (sast, deps, secrets, iac pass; its container scan needs a built image and no container file changed) run for the submit check.
- The full machine report is attached to the task as `submit-check`. Notes for the reviewer: `README.md` in this folder.
