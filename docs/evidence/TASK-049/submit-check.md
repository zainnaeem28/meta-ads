# TASK-049 evidence

- `pnpm --filter @shroomap/api lint typecheck test:unit test:integration`, `scripts/ci/layers.sh`, `scripts/ci/contract.sh` on real PostgreSQL and MinIO; junit and lcov under `apps/api/reports/brief-ai/`.
- `scripts/ci/rescan.sh --dry-run` writes `reports/sast.sarif`, `reports/deps.json` and `reports/secrets.sarif` for the submit check.
- The full machine report is attached to the task as `submit-check`. Notes for the reviewer: `README.md` in this folder.
