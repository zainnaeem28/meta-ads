# TASK-036 identity 4/4a: invitations, evidence notes

- API-110..113 (`transport/invitations.controller.ts`, scope A), `application/invitations.service.ts`, the Drizzle store
  `application/invitations.store.ts`, and the hourly `identity.expire-invitations` job `application/invitations.jobs.ts`.
- Send state (ARCHITECTURE 5.1): tx 1 inserts `invited`/`pending` and the audit event; the provider call runs outside any
  transaction (probed in the test: no session of the database is `idle in transaction` during a provider call); tx 2 moves
  `send_state` to `sent` (handle stored) or `send_failed`. A late answer for a revoked or stale row is not stored and its
  provider invitation is revoked at once.
- A closed (`revoked`/`expired`) row that still has `idp_invitation_id` means a provider revoke is owed; the job retries it
  and clears the column. A provider revoke is made only when a handle is set. The handle is never returned or logged
  (canary test over responses, audit rows and captured log lines).
- Same 202 body for a fresh and a registered address; the 422 domain check runs before the registered check so it cannot be
  used to enumerate. Rate limit 20 per admin per hour, one `invitation-send` bucket shared by API-111 and API-112.
- List shows an overdue `invited` row as `expired` and a `pending` send older than `INVITATION_SEND_STALE_MIN` as
  `send_failed` at read; the job persists both. Cursor: signed (`CURSOR_SIGNING_KEY`), bound to the admin and the state filter.
- Worker wiring: `IdentityModule.registerWorker(env)` plus `identityJobHandlers` in `bootstrap/worker.module.ts`; the queue
  is scheduled hourly because the handler is registered. Proof: `transport/invitations.integration.test.ts` drives the real
  `createApiApp` and `createWorkerApp` on real PostgreSQL (the job fires from a queued pg-boss message).
- Tests: unit `application/invitations.test.ts` (fake store); integration `transport/invitations.integration.test.ts`
  (TC-INV-01..09, TC-ACC-05, TC-ACC-11, authorization 401/403, validation 400, 404/409, 429, paging, computed states).

Deviations and notes for the reviewer:
- Files outside the listed paths, forced by the ticket's own report flags: `apps/api/vitest.config.ts` (junit reporter
  `reports/invitations`, coverage exclusion of the Drizzle store, as for the identity repositories) and `apps/api/package.json`
  (`test:unit` copies the lcov to `reports/invitations/lcov.info`).
- The store sits in `application/` because the listed paths exclude `infrastructure/`; it imports no infrastructure file.
- `reports/deps.json` is not produced by `scripts/ci/deps.sh`; `reports/deps.sarif` and `reports/audit.json` are passed.
- `platform-migration.integration.test.ts` needs `pg_dump`: run with `PG_CLIENT_ROOT=/tmp/pgroot` (all 205 integration tests pass).
- TC-INV-07 (erasure of a removed subject's invitations) belongs to the lifecycle erasure ticket; not built here.
