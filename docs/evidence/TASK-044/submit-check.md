# TASK-044 evidence

- Unit and integration (`pnpm --filter @shroomap/api lint typecheck test:unit test:integration`) on real PostgreSQL; junit and lcov under `apps/api/reports/usage/`.
- `scripts/ci/layers.sh`, `scripts/ci/contract.sh`, `scripts/ci/sast.sh`, `scripts/ci/deps.sh`, `scripts/ci/secrets.sh` run for the submit check.
- The full machine report is attached to the task as `submit-check`. Notes for the reviewer: `README.md` in this folder.
