# TASK-058 evidence

- `reports/deps.sarif` is read in place of the `reports/deps.json` the ticket names (as in TASK-044 and TASK-053).
- The ticket's `pnpm --filter @shroomap/api lint typecheck test:unit test:integration` is run as four commands, one script each (pnpm takes one script per call).
- The full machine report is attached to the task as `submit-check`.
- Integration proof: `apps/api/src/modules/lifecycle/transport/campaign-deletion.integration.test.ts` (real `createApiApp` with `fastify.inject`, real `createWorkerApp`, real PostgreSQL, in-process S3 stand-in that also plays the `erasure-ledger` bucket).
