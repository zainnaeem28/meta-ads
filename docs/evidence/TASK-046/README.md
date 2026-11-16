# TASK-046 campaigns 1/2: evidence notes

- Migration `0070_task-046-campaigns.sql` (M0008, range 0070-0079), generated with `pnpm db:generate --name=0070_task-046-campaigns`:
  `campaigns` (`active|deleting`, trigram GIN on name and description, `campaigns_owner_active_idx`) and `drafts` (every intake column of
  ARCHITECTURE §2.2, check constraints for each range, `drafts_owner_open_idx`, `drafts_campaign_uq`). `drafts.campaign_id` is a cascading FK to
  `campaigns`; both `product_media_id` columns are `SET NULL` FKs to `media_objects` (SB-D17). Grants: full DML on both tables to `app_api` and
  `app_worker`. Compensating SQL for the rollback check: `0070-compensating.sql` here (the harness fixture folder is outside this ticket's paths).
- One addition to the dictionary: partial unique indexes `drafts_product_media_uq` and `campaigns_product_media_uq` make "an upload belongs to one
  draft or campaign only" (SB-D2) a database rule, not only a read-then-write check; the service also reads first so the answer is a clean 409.
- API-020 `GET /drafts` (open drafts, `updated_at desc, id desc`, signed cursor, `limit` 1..50), API-021 `POST /drafts` (201, `ETag`, `Location`, 30/min),
  API-022 `GET /drafts/{id}` (`ETag`; a submitted draft is returned with `campaignId`), API-023 `PATCH` (`If-Match: "<version>"`, 60/min; stale version
  409 `version_conflict`, submitted draft 409 `state_conflict`, state is checked first), API-025 `DELETE` (204; submitted draft 409 `state_conflict`).
  Owner scope is in the statement (`WHERE owner_id`), so a foreign and a deleted draft give one 404 body.
- Rate limits: the per-route table in `rate-limit.module.ts` belongs to the platform ticket, so 30/min and 60/min are applied in the controller with
  `RateLimiter.consume` (scopes `draft-create` and `draft-patch`, per user) on top of the general 300/min; a refusal is 429 `rate_limited` with `Retry-After`.
- Delete order (REQ-013): the image object goes first (derived `u/` and `q/` keys, idempotent), then one transaction deletes the draft row, the media row
  (quota returned) and writes the `draft.deleted` audit event. A storage failure is 503 with nothing changed; a retry finds the same draft.
- Wiring: `CampaignsModule.register(process.env, { audit, media })` appended to `bootstrap/api.module.ts` next to the media module (it needs both). Proof:
  `transport/drafts.integration.test.ts` builds the real api through `createApiApp` on real PostgreSQL and MinIO and sends `fastify.inject` requests to all
  five operations.

Test mapping: TC-INT-01 (create, save, restore), TC-INT-02 (segment count 0/5/-1/4.5 rejected, 4 gives 60 s), TC-INT-05 (stale save 409, plus a real
concurrent pair: one 200, one 409), TC-INT-06 (start over = new draft), TC-INT-07 (malformed, unknown, oversized: 400/413, nothing stored), TC-DEL
draft cases (object, row, quota, audit, 503 retry), TC-AUT (foreign = deleted = unknown, one body), TC-INT-03 is web-only (the server side is the
failed-save-keeps-values assertion in the TC-INT-02 test).

Notes and limits for the reviewer:
- **Rejected image.** The contract lists 422 `media_not_ready` for a rejected image, but `MediaService.attach` answers a rejected row with 404 (it hides
  it like a foreign one) and 422 only for `processing`. The media module is outside this ticket's paths; the proposal is `attach` throwing `media_not_ready`
  for the caller's own rejected upload (or a public state read). Tested here: processing 422, foreign 404, unknown 404.
- **Detach.** Detaching an image (PATCH `productMediaId: null`) clears the draft's reference, but `media.attach` set `attached_at` and the media module has no
  detach, so the 24 h unattached sweep does not pick it up yet ("detached upload expires after 24 h", API-023). It needs a `MediaService.detach` in the media module.
- **Submit race.** Delete removes the object before the locked transaction; a submit (API-024, next ticket) that lands between the two would find the
  draft submitted and delete answers 409 after the object is gone. Submit locks the draft `FOR UPDATE` (§2.6), so the window is the two statements of delete.
  The submit ticket should also confirm the image `ready` and present at attach time.
- `apps/api/vitest.config.ts` and `apps/api/package.json` (junit and lcov under `reports/campaigns`, coverage include/excludes) are outside the listed paths but forced by
  this ticket's report flags, as in TASK-044.
- `scripts/ci/db-check-history.sh` fails five tests on `origin/dev` before this ticket ("app_api lacks SELECT on public.provider_keys": the M0004 column grants);
  it is not one of this ticket's required checks and my migration adds no grant finding.
- `src/platform/idempotency/limits.integration.test.ts` raised one unhandled "terminating connection due to administrator command" in one full
  `test:integration` run; the rerun on the same commit passed all 27 files (a teardown race in that file, not in this ticket's suite).
