# TASK-030 worker process

Files: `apps/api/src/main.worker.ts` (config check, signal handlers), `bootstrap/worker.module.ts` (composition root `createWorkerApp`: database, pg-boss in the worker role, audit, `WorkerRuntime`; the cron table `CRON_SCHEDULES`), `platform/jobs/sweep.ts` (`runRecoverySweep`: `pg_try_advisory_lock('recovery-sweep')`, then every registered hook), `watchdog.ts` (exit 70), `heartbeat.ts` (`worker_heartbeat` every minute, `HEARTBEAT_URL_WORKER` ping every fifth).

Tests: `worker-runtime.test.ts` (unit: TC-RSE watchdog, heartbeat, sweep lock skip) and `worker.integration.test.ts` (through `createWorkerApp` on real PostgreSQL: job handled by the worker process, kill mid-job without a second submit, two workers and one sweep, watchdog exit 70 on a hung sweep, drain within and at the end of `WORKER_DRAIN_SECONDS`).

## Design notes
- Each owning ticket contributes its queue handler (`WorkerOptions.handlers`) and its sweep hooks (`sweepRegistry.register`); an hourly queue is scheduled only when a handler for it is registered, the every-minute sweep always.
- The start-up sweep runs once at boot and is not awaited, so a hanging sweep is caught by the watchdog rather than blocking start-up.
- Watchdog: trips on a sweep tick not finished for `WORKER_WATCHDOG_SECONDS`, or on a check timer that fired later than that. A loop blocked forever cannot run any in-process check; the supervisor's liveness probe covers that case.
- `KeyUnsealer`: no unsealer module exists yet; `worker.module.ts` is the only file that may bind it, and its ticket adds the binding there.
- Drain: `pg-boss` `stop({graceful, timeout: WORKER_DRAIN_SECONDS})`, then the context closes; a job still running at the end is left to queue expiry and the sweep, never retried by this process.

## Notes for the Orchestrator (outside the allowed paths, not changed)
- `test:unit` writes no `reports/worker/*`; the submit run copies `reports/http/{junit.xml,lcov.info}` there.
- Integration suite needs `PG_CLIENT_ROOT=/tmp/pgroot` (pg_dump) for the TASK-025 migration tests.
