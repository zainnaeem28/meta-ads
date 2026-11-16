# TASK-028 evidence: platform/jobs core

| Test | Where | Proves |
| --- | --- | --- |
| TC-BKP-08, probe 11 | `tests/integration/jobs/jobs.integration.test.ts` | `createApiApp` and the built `main.api.js` refuse to start before `jobs:migrate` (schema not installed), with a catalogue queue missing (named), and with the schema behind; the worker-role start refuses a missing queue; a pg-boss migrate start and `createQueue` by `app_api` and `app_worker` (partitioned) are refused; plain `createQueue` by `app_api` is refused |
| TC-JOB (enqueue) | same | `send({db})` on the caller's Drizzle transaction rolls back with it and commits with it; a job committed by the api is handled by a worker-role pg-boss |
| `jobs:migrate` idempotent | same | first run creates every catalogue queue, second creates none and updates all; stored `retryLimit` and `expireInSeconds` match the catalogue |
| Catalogue table test, lint | `src/platform/jobs/jobs.test.ts` | the ten queues of ARCHITECTURE §2/§5 are present; submit queues `retryLimit 0`; `createQueue`/`updateQueue`/`deleteQueue` appear only in `database/jobs-migrate.ts` |
