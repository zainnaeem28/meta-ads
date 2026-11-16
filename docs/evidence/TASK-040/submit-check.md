# TASK-040 evidence

- Unit: `pnpm --filter @shroomap/api test:unit` passes (provider-keys service 17, controller 6, units 14 tests); lcov/junit under `apps/api/reports/keys/`.
- Integration through `createApiApp` (the `main.api.ts` composition root) on real PostgreSQL: `src/modules/provider-keys/transport/provider-keys.integration.test.ts` (API-010..013, 422 key_invalid, untested on timeout/403, 5/10 min limit, replace/delete, canary scan, ADR-009 column grants) and `infrastructure/provider-keys.integration.test.ts`.
- `scripts/ci/layers.sh`, `scripts/ci/contract.sh`, sast, deps, secrets: PASS.
- `test:integration` passes in full (incl. TC-BKP-01/06/07/09) with a user-space `pg_dump` 18.7 (official PGDG package) on PATH; the earlier FAIL was only a missing client binary.
- The full machine report is attached to the task as `submit-check`.
