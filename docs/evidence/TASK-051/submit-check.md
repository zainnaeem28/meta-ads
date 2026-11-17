# TASK-051 evidence

Brief 4/4: API-024 (`POST /drafts/{draftId}/submit`), API-035 (`POST /media/{mediaId}/analysis`), API-036 (`GET /media/{mediaId}/analysis`), API-053 (`POST /campaigns/{campaignId}/brief/regenerate`).

- Unit tests: `apps/api/src/modules/brief/transport/submit.test.ts` (completeness rule, reuse hash, job summary). Integration test: `transport/submit.integration.test.ts`, through `createApiApp` (the composition root `main.api.ts` runs) with `fastify.inject` on real PostgreSQL and MinIO, and the real worker (`createWorkerApp`) with a local TLS server in place of api.openai.com. Responses are validated against the OpenAPI schemas (`SubmitDraftResponse`, `ImageAnalysisResponse`, `BriefJobResponse`). junit and lcov under `apps/api/reports/brief-jobs/`. The full machine report is attached to the task as `submit-check`.
- Real entry point: a submit through the running api creates the campaign, brief, job, reservation and the pg-boss message in one commit; the worker handles `brief.generate`, the stub completes it, the brief is `draft` with segments and the reservation is released.

## Acceptance map

| Acceptance | Test |
| --- | --- |
| Resubmit and lost-response replay: one campaign, one job, one reservation | `resubmit and lost-response replay ...`, `concurrent submits ...` (same key, different keys, 6 in parallel) |
| Missing key creates no job and names the setting; cap reached is the specified 422 | `a missing or disabled key ...`, `the spend cap is checked ...`, and the same for API-035 and API-053 |
| Submit creates a worker-visible job and the stub completes it | `creates the campaign, brief and job in one request; the worker stub completes the job` |

## Decisions for the reviewer

- **Where the code lives.** API-024 is owned by `campaigns` but needs the brief tables and the job rule; `campaigns` (layer 4) may not import `brief` (layer 5). The submit controller and service therefore sit in `brief/transport/` (like `media-upload.service.ts` in media) and read and write `drafts` and `campaigns` through the shared Drizzle schema, as the worker's `DrizzleBriefJobs` already does. The product image is attached through `MediaService.attach` (media's index). Everything is in `transport/` under the allowed prefixes `submit*`, `analysis*`, `regenerate*`.
- **SB-D14 order** (`submit-jobs.ts`): draft row lock (submit) or brief row lock (regenerate) -> idempotency record insert (the platform `withIdempotency`) -> reuse lookup (the live job of the same work, `brief_jobs_reuse_uq`) -> `spend:` lock -> key check (`key_missing`, `key_disabled`) -> cap check and reservation (`UsageService.reserve`: 2 text calls for a brief, 1 vision call for an analysis) -> job insert -> `enqueue` on the same transaction. A refusal rolls everything back, so no campaign, brief, job, reservation or idempotency record remains.
- **Reuse hash**: `sha256(kind, subject, generationSeq)`; a brief generation is per campaign and generation number, an analysis per image. A failed or cancelled job is outside the unique index, so a retry makes a new job.
- **Replay.** A submit of a draft whose `campaign_id` is set returns the stored campaign and its newest generation job (`reused: true`), with or without the key, even when that job failed; the key is recorded so a later request replays the same way. A repeated key on regenerate is looked at before the brief state, so the retry of the request that started the generation is not a 409. The same key with another request is 409 `idempotency_key_reused` (the hash covers method, path, body).
- **Regenerate** (`draft`, `accepted` or `failed` -> `generating`): the brief's `generation_seq` and `version` go up by one and `accepted_at` is cleared in the same transaction as the job; the old segments stay until the worker writes the new text (SB-D11). 409 `state_conflict` when already generating.
- **Image description at submit**: the draft's own description, else the description of the image's latest completed analysis; neither gives 400 `validation_failed` with one detail per missing field (`productDescription`, `audience.ageMin`, ..., `concept` or `script`).
- **Analysis GET** returns the newest job (or `null`) and the description of the newest completed one; a foreign or missing image is 404.

## Files outside the ticket's allowed paths (mechanical, needed to wire and check the ticket)

- `apps/api/src/bootstrap/api.module.ts`: the usage instance is built once and passed with the media instance to `BriefModule.register(env, { media, usage })` (the job operations need both; without media, as before, only the brief read, edit, accept and clear operations are served).
- `apps/api/vitest.config.ts`, `apps/api/package.json`: the `reports/brief-jobs` junit output and lcov copy, and the coverage exclusion of the files proven on real PostgreSQL (the pattern earlier brief tickets used).

## Open item for the Orchestrator / Solution Architect

- The api needs `OPENAI_TEXT_MODEL` and `OPENAI_VISION_MODEL` to price the reservation, but the configuration registry (`platform/config/registry.ts`) scopes them to the worker (`W`). The api reads them from its environment when present; when they are not set a job-creating call is 503 `service_unavailable` (nothing is created). The registry scope should become api and worker for both, and the deployment must give the api the same values the worker has.
