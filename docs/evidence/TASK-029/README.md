# TASK-029 platform/jobs runtime

Files: `claim.ts` (counted claim, limit 5 under `run:{ownerId}`), `at-most-once.ts` (`submitOnce`, orphan sweep, late task-ID write), `poll.ts` (`schedulePoll`, `runPoll` lease on `next_poll_at`, deadline rule, re-arm hook), `sweep-registry.ts` (hook registration). All take the job table name, so they work over any SB §3.5 table; tests use a fake `fake_jobs` table on the shared test PostgreSQL.

Tests: `jobs-runtime.test.ts` (unit command, real PostgreSQL; TC-CLP-03, TC-CLP-06, TC-PCA-01..03) and `jobs-runtime.integration.test.ts` (real `createApiApp` composition root plus a worker-role pg-boss handling the poll job).

## Notes for the Orchestrator (outside the allowed paths, not changed)
- The two test files sit in `apps/api/src/platform/jobs/` next to TASK-028's, because the vitest includes only pick up that tree.
- `test:unit` writes no `apps/api/reports/jobs-runtime/{junit.xml,lcov.info}`; the submit command copies `reports/http/*` there. A one-line addition to the `test:unit` script would make it permanent.
- `recoverySweep()` itself is not in this ticket's paths; it runs `sweepRegistry.runAll(...)`.
- Environment: `pg_dump` is not installed here, so 5 tests in `tests/integration/migrations/platform-migration.integration.test.ts` (TC-BKP-01/06/07/09, G-1) fail with a null exit status. They are TASK-011/025 tests and do not touch this change.
