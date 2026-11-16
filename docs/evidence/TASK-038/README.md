# TASK-038 evidence: audit API, alerts list and acknowledge (API-125, API-126)

Official check report: `submit-check.md` (uploaded to the task as document `submit-check`; it names the exact commit).

| Acceptance | Proof |
| --- | --- |
| Non-admin gets 403 and an audit event; acknowledge twice returns the first acknowledger | `alerts.integration.test.ts`: a non-admin gets 403 `forbidden_role` on both operations and two `auth.denied` rows appear (written by the session guard); an admin with a stale sign-in gets 403 `recent_auth_required` and the same audit row (written by the controller), alert unchanged; a second administrator's acknowledge returns 200 with the first `acknowledgedBy` and the unchanged `acknowledgedAt`; unknown ID 404 `not_found`; malformed ID 400 |
| Pagination invariants on `(acknowledged_at nulls first, raised_at desc, id desc)` | Seven alerts (microsecond timestamps, ties on `acknowledged_at`) paged with `limit=3` give exactly the SQL order, no gap or repeat; `acknowledged=false/true` filters; a cursor of another filter, a tampered one and bad `limit`/`acknowledged` give 400 `validation_failed` |
| Contract validation of both responses | Ajv against `AlertResponse` and `AlertPage` of `packages/contracts/openapi.yaml` (design.5); no `@` appears in any list body (user IDs and counts only) |
| Wired into the running product, one test through the real entry point | The test boots `createApiApp` (the root `main.api.ts` runs) on real PostgreSQL and uses `fastify.inject` on `/api/v1/admin/alerts` and `/api/v1/admin/alerts/{id}/acknowledge`; `AuditModule.register` now declares `AlertsController` (scope A) |

## Decisions

- Scope A (token, status, MFA, role; `auth.denied` on refusal) is enforced by the global guard; recent authentication is checked in the handler through `requireRecentAuth`, with its own `auth.denied` write, because the operation table gives A plus recent auth and no scope value combines them.
- Cursor: `platform/http` signed cursor, owner = the administrator, filter = the `acknowledged` value, sort key = `[acknowledged_at, raised_at, id]` as PostgreSQL text so microseconds survive. Key is `CURSOR_SIGNING_KEY` (required in staging and production); a per-process random key is used when it is unset (local runs).
- `AlertsController` injects `DATABASE` optionally and answers 401 when there is no database or no actor, so the route never serves without the session guard.
- The test finds the local identity provider through the Nest container: the audit layer must not import identity (layer check).
- Environment: five `platform-migration.integration.test.ts` tests (pg_dump based) fail here because no `pg_dump` is installed; unrelated to this change.
- `apps/api/reports/audit-api/{junit.xml,lcov.info}` are copies of the audit unit run's output (package scripts are outside the allowed paths).
