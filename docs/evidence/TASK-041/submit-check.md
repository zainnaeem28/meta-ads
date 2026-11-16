# TASK-041 evidence

- Unit and integration (`pnpm --filter @shroomap/api lint typecheck test:unit test:integration`) on real PostgreSQL and MinIO; junit and lcov under `apps/api/reports/media-core/`.
- Adapter contract on MinIO: conditional put, presign with disposition, prefix delete. R2 run: NOT_RUN, a deployment-time owner item (G-1).
- `scripts/ci/layers.sh`, `scripts/ci/contract.sh`, `scripts/ci/sast.sh`, `scripts/ci/deps.sh`, `scripts/ci/secrets.sh` run by the submit check.
- The full machine report is attached to the task as `submit-check`.
