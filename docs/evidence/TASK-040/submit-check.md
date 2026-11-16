# TASK-040 evidence

- Unit: `pnpm --filter @shroomap/api test:unit` passes (provider-keys service 17, controller 6, units 14 tests); lcov/junit under `apps/api/reports/keys/`.
- Integration through `createApiApp` (the `main.api.ts` composition root) on real PostgreSQL: `src/modules/provider-keys/transport/provider-keys.integration.test.ts` (API-010..013, 422 key_invalid, untested on timeout/403, 5/10 min limit, replace/delete, canary scan, ADR-009 column grants) and `infrastructure/provider-keys.integration.test.ts`.
- `scripts/ci/layers.sh`, `scripts/ci/contract.sh`, sast, deps, secrets: PASS.
- Known environment limit: 5 tests in `tests/integration/migrations/platform-migration.integration.test.ts` (TC-BKP-01/06/07/09, GAP G-1) need `pg_dump`, which is not installed in this sandbox; they do not touch provider-keys.
- The full machine report is attached to the task as `submit-check`.
