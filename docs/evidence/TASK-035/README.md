# TASK-035 evidence: identity 3/4, admin invariant, role change, admin user list, session revoke

Official check report: `submit-check.md` (uploaded to the task as document `submit-check`; it names the exact commit).

| Acceptance | Proof |
| --- | --- |
| Two admins: A removes B succeeds, count stays >= 1; last admin cannot be demoted, suspended or removed; no self action (422, audit each) | `application/admin-users.integration.test.ts` "A removes B" (200, ETag, `role.revoked`, alert, job), "self action" (422 `self_action` + `admin_invariant.refused`), "last admin" (`setStatus` suspend and remove refused with `last_admin`, one audit event each, one admin remains). Unit: `admin-users.test.ts` |
| Concurrent demotions cannot leave zero admins | "keeps at least one admin when two admins demote each other at once": six rounds of two simultaneous PUTs under the `admin-invariant` lock, exactly one 200, one active admin left |
| Every admin route writes an audit event on a 403 | "refuses a user ... and an admin without a second factor": GET and PUT each add one `auth.denied` event (guard, scope A) |
| Wired and proven through the real entry point | The integration test boots `createApiApp` (the root `main.api.ts` runs) on real PostgreSQL and calls `fastify.inject` on `/api/v1/admin/users` and `/api/v1/admin/users/{id}/role`; bodies validated with Ajv against `AdminUserPage` / `AdminUserResponse` of `openapi.yaml` |

## Decisions

- Role change in one transaction: lock `admin-invariant`, load, same role is 200 unchanged with no event, inactive target 409 `state_conflict`, stale `If-Match` 409 `version_conflict`, invariant (self first, then last admin), versioned update, audit `role.granted|revoked`, alert `admin_role_changed` (subject = the account, announced after commit), `identity.revoke-sessions` job on the same transaction. A refusal is audited in the same transaction, which commits, and the 422 is raised after.
- `setStatus(tx, ...)` is for the lifecycle caller inside its own transaction: same lock and invariant; it records only refusals (on its own connection, since the caller's transaction ends with the error) and queues the revoke job when leaving `active`. The lifecycle module records its own success events (`account.suspended` ...).
- `listUsers`: keyset on `(created_at desc, id desc)` with the microsecond `created_at::text` as sort key in the signed cursor (owner = actor, filter = status). `CURSOR_SIGNING_KEY` is read by `IdentityModule.register`.
- `erasure` is always `null` until the lifecycle module (a higher layer) has deletion runs to show.

## Limits and items for the Orchestrator

- Worker wiring: `revokeSessionsHandler(RevokeSessionsService)` is exported from the module index and proven against the real job row and `LocalIdentity`; registering it in `bootstrap/worker.module.ts` (`handlers['identity.revoke-sessions']`, with an `IdentityPort`) is outside the allowed paths and needs its own change.
- Files outside the allowed paths: `infrastructure/admin-users.queries.ts` and its test (the read query; application code may not import the ORM adapters), `apps/api/vitest.config.ts` and `apps/api/package.json` (junit and lcov copy for `reports/identity-admin`, as TASK-034 did).
- The ticket's flag `reports/deps.json` does not exist in this repository; the dependency report is `reports/deps.sarif` and `reports/audit.json`. The checks are run as separate commands (`pnpm --filter @shroomap/api lint`, `typecheck`, ...) because `pnpm ... lint typecheck ...` passes the later names as arguments to eslint.
