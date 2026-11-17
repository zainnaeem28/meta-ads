# TASK-052 evidence

Production 1/6: migration 0090 (`video_jobs`, `qc_runs`), segment clip operations API-060 (`POST /campaigns/{campaignId}/segments/{position}/jobs`), API-061 (`GET /campaigns/{campaignId}/video-jobs`), API-062 (`GET /video-jobs/{videoJobId}`), API-063 (`POST /video-jobs/{videoJobId}/retry`), and the `CampaignProgressReader` implementation.

- Unit tests: `apps/api/src/modules/production/domain/video-job.test.ts` (reuse hash, out-of-date rule, labels, retryable and non-terminal states, progress derivation) and `transport/video-view.test.ts`. junit and lcov under `apps/api/reports/prod-jobs/`.
- Integration test: `apps/api/src/modules/production/production.integration.test.ts`, through `createApiApp` (the composition root `main.api.ts` runs) with `fastify.inject` on real PostgreSQL (19 tests). Responses are validated against `VideoJobResponse` and `SegmentJobsResponse`. The full machine report is attached to the task as `submit-check`.
- Whole api integration suite on this commit: 35 files, 414 passed, 1 skipped. Unit: lines 97.07 %, branches 92.84 %. `scripts/ci/layers.sh`: 0 violations.

## Acceptance map

| Acceptance | Test |
| --- | --- |
| Matching in-flight job returns the same job, no new provider call; completed too; a failed one creates a new job | `a matching in-flight or completed job is returned ...` (TC-CLP-03), `concurrent requests ...` |
| Edit after accept marks the clip out of date at read | `an edit after accept marks the clip out of date at read ...` |
| Segment delete with jobs refused by the FK | `a direct delete of a segment that has jobs is refused by the foreign key; the campaign delete takes everything` |
| Cross-user job IDs return the single not-found | `a stranger, a missing campaign ...`, `is owner scoped ...` (read, list, retry) |
| 202 `pending` at the running limit | `the running limit never refuses: six clips at once are six pending jobs` (TC-CLP-10) |
| `brief_not_accepted`, `key_missing`, `key_disabled`, `spend_cap_reached`: nothing created | `needs an accepted brief ...`, `a missing or disabled WaveSpeed key and a reached cap ...` (TC-CLP-09) |
| Retry is a new row, no automatic retry, 409 on a live job | `a failed or cancelled clip gets a new row ...` (TC-CLP-05), `keeps the checks of a new job ...` |
| Wired into the running product | every API test goes through `createApiApp` + `fastify.inject`; the progress reader is read through the bootstrap-bound instance |

## Decisions for the reviewer

- **Brief data without a brief import.** SB-D11 names `brief.segmentForProduction()` and `brief.segmentRevisions()`. The brief module has no `index.ts` and is outside this ticket's allowed paths, so production reads `brief_segments`, `briefs` and `campaigns` through the shared Drizzle schema (read-only, in the same transaction, the brief row locked `FOR UPDATE` so an edit cannot move a segment between the check and the insert) and never writes them. The layer check passes (no module import). Moving this read behind a `brief` index function later is mechanical.
- **SB-D14 order** (`VideoJobsService`): campaign/brief lock -> idempotency replay lookup (before any state check, so a retried request is not refused) -> `brief_not_accepted` (brief not `accepted`, or segment `retired`, distinct message) -> reuse lookup of the live job of the same work (`video_jobs_reuse_uq`) inside the idempotency record -> `spend:` lock -> WaveSpeed key (`key_missing`, `key_disabled`) -> cap check and reservation (the WaveSpeed call and the first QC transcription together, ARCHITECTURE §5.5) -> job insert -> `production.video-submit` enqueue on the same transaction. A concurrent creator that wins the reuse index makes the loser rerun once and reuse.
- **Reuse hash**: `sha256(["video", segmentId, prompt, dialogue, referenceMediaId, durationSeconds, resolution, aspectRatio])`. The dialogue is included next to the prompt because a changed line must not reuse an old clip (the revision also goes up). Failed and cancelled rows are outside the unique index.
- **Reference image**: the campaign's product image only when it is `ready` and the owner's and `useProductImage` is not false; otherwise the text-to-video model. Retry keeps the original job's reference when it is still ready.
- **Running limit**: creation never refuses for it; every job is created `pending`. Claiming under `RUNNING_JOBS_PER_USER` is the worker's claim step (a later production ticket).
- **Cancellation** (`cancelForCampaign`, `cancelForOwner`, caller's transaction): unfinished clips and QC runs become `cancelled` with the cause class; a clip that was `submitting` has its sent call converted to an `unconfirmed` usage event (SB-D9) and the rest of every reservation is released.
- **`inFlightForKey(owner, provider)`** counts unfinished clips for `wavespeed` and QC runs for `openai`. `provider-keys` is wired with its own `NoJobsInFlight` until a later ticket binds this method (outside this ticket's paths).
- **Progress reader** (`VideoProgressReader`): `processing` = any unfinished brief job, clip or QC run; `failed` = not processing and the brief failed or the latest clip of an active segment failed or was cancelled; `completed` needs a `done` assembly, which has no table before the assembly ticket, so it is empty for now. The api bootstrap creates a bridge so `CampaignsModule` gets the reader before the database exists (`progressBridge()`), and the production module binds the real reader when it is built.
- **Grants** (end of 0090): `app_api` and `app_worker` read, insert and update both tables; neither deletes (jobs leave through the campaign cascade).

## Files outside the ticket's allowed paths (mechanical, needed to wire and check the ticket)

- `apps/api/src/bootstrap/api.module.ts`: the import line, the progress bridge handed to `CampaignsModule.register`, and `ProductionModule.register` (about six lines, not a single import line, because the reader must reach campaigns).
- `apps/api/vitest.config.ts`, `apps/api/package.json`: the `reports/prod-jobs` junit output and lcov copy, the production coverage include and the exclusion of the files proven on real PostgreSQL.
- `apps/api/src/modules/campaigns/transport/history.integration.test.ts`: the test database now also applies 0080 and 0090 (the real reader reads those tables).
- `apps/api/src/database/migrations/meta/*`: the generated journal entry and `0008_snapshot.json`.

## Not caused by this ticket

- `pnpm db:check-history` was already failing before this change: no compensating migration exists for 0020 to 0080 (`tests/integration/migrations-check/fixtures/compensating/` holds 0001 and 0010 only) and the grants check reports `app_api lacks SELECT on public.provider_keys` (column-level grants of 0030). It is not in this ticket's required checks. The new tables raise no grants finding. A compensating migration for 0090 is `DROP TABLE qc_runs; DROP TABLE video_jobs;` and is needed together with the missing ones.
