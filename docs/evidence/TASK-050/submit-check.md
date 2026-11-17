# TASK-050 evidence

Brief 3/4: API-050 (`GET /campaigns/{campaignId}/brief`), API-051 (`PATCH`), API-052 (`POST .../brief/accept`), API-054 (`POST /claim-issues/{issueId}/clear`).

- Unit (`apps/api/src/modules/brief/application/brief.service.test.ts`, `transport/brief.controller.test.ts`) and integration (`transport/brief.integration.test.ts`) tests; the integration test goes through `createApiApp` (the composition root `main.api.ts` runs) with `fastify.inject` on real PostgreSQL and checks every response against the OpenAPI schemas. junit and lcov under `apps/api/reports/brief-api/`.
- `scripts/ci/layers.sh`, `scripts/ci/contract.sh`, and `scripts/ci/rescan.sh` (sast, deps, secrets) run for the submit check. The full machine report is attached to the task as `submit-check`.

## Decisions for the reviewer

- **Version and ETag.** The ETag is `briefs.version`. Edit and accept each bump it; clear does not (it changes no segment text or brief state, and bumping would make the next edit after a clear fail with 409). An accepted brief returns 200 when the `If-Match` equals its current version (accept is idempotent at the accepted version); any other version is 409 `version_conflict`.
- **Check order on edit/accept:** not found (404, owner-scoped) -> `version_conflict` -> `state_conflict` (the brief must be `draft` or `accepted` to edit, `draft` to accept) -> body rules.
- **Edit re-runs the rules on the edited segments only** (`reconcileIssues` with `checked = changed = edited segments`). A segment whose text did not change is not written and its revision stays. An edit that changes nothing writes nothing (same ETag).
- **High-risk issues** have no clear path: API-054 answers 422 `claim_not_clearable` for the class whatever the reason, before any state check; only an edit that stops the rule firing closes them (`closed_by_edit`).
- **Jobs out of date** is derived from segment revisions (SB-D11), so bumping the revision is the flag; nothing else is stored.
- **Words**: more than 120 words in one dialogue is 400 `too_long` (the `word_count` column check), not a 500.
- **Issues listed** are the open ones first, then the ones resolved since the last accept (all when never accepted), at most 200.

## Files outside the ticket's allowed paths (mechanical, needed to run the ticket's own checks)

- `apps/api/src/modules/brief/infrastructure/repositories/brief.repository.ts`: the Drizzle repository. The layer rules forbid `application` importing an adapter and the port needs one, so it cannot live under `application`/`transport`.
- `apps/api/vitest.config.ts` and `apps/api/package.json`: the `reports/brief-api` junit output, the lcov copy, and the coverage exclusion of the port file and the repository (proven on real PostgreSQL), the same one-line pattern earlier brief tickets used.
- Integration test setup notes: the app is started on the owner URL, as `history.integration.test.ts` does; the runtime roles' grants on the brief tables are proven by TASK-048's `asRole` tests.
