# TASK-041 media 1/3: evidence notes

- Migration `0040_task-041-media.sql` (M0005 content, range 0040-0049), generated with `pnpm db:generate --name=0040_task-041-media`:
  `media_objects`, `storage_usage` (ARCHITECTURE §2.2 dictionary, every constraint and index); grants SELECT/INSERT/UPDATE/DELETE to
  `app_api` and `app_worker`, no TRUNCATE or DDL.
- `StoragePort` (`modules/media/domain/storage.ts`): `put` (conditional, `If-None-Match: *`, size-capped), `get`, `delete`, `deletePrefix`,
  `list`, `presignGet` (with `response-content-disposition`). Typed `StorageUnavailable`, `StorageNotFound`, plus `StorageKeyExists` and
  `StorageTooLarge`. One S3 implementation (`infrastructure/s3-storage.ts`) with `R2Storage` (`region: auto`, account endpoint) and
  `MinioStorage`; `createStorage` picks by endpoint host. Keys come only from `domain/keys.ts` (`q/`, `u/`, `smoke/`), UUID-validated.
- `MediaService`: `upload()` (quota reserved under the `storage_usage` row lock and the `processing` row committed, then the conditional put
  outside any transaction; a failed put runs a compensating transaction that deletes the row and returns the reservation, 503),
  `attach()`, `registerObject()`, `unregisterObject()`, `quota()`, `signedUrl('browser' | 'provider-fetch')`.
- Wiring: `MediaModule.register(process.env)` appended to `bootstrap/api.module.ts` (only when `DATABASE_URL` and `R2_ENDPOINT` are set).
  Proof: `media.integration.test.ts` builds the real api through `createApiApp` and uses the service and port it wires; the start-up check
  fails for real with `MEDIA_BROWSER_URL_TTL_SEC=960`.

Tests: `keys.test.ts`, `media.service.test.ts`, `media.module.test.ts`, `s3-storage.test.ts` (unit); `s3-storage.integration.test.ts`
(adapter contract on a real MinIO: conditional put, presign with disposition, prefix delete, expiry, anonymous read/list denied, one-object URL),
`media.integration.test.ts` (real PostgreSQL + MinIO through `createApiApp`: constraints, grants, quota, concurrency, compensation, ownership,
signed URLs).

R2 contract run (TC-MED-30): **NOT_RUN**, a deployment-time owner item (G-1). The same contract suite switches to R2 when `R2_CONTRACT_ENDPOINT`,
`R2_CONTRACT_BUCKET`, `R2_CONTRACT_ACCESS_KEY_ID`, `R2_CONTRACT_SECRET_ACCESS_KEY` are set; nothing waits for it.

Decisions and notes for the reviewer:
- Quota is reserved with the declared size and corrected to the stored size after the put (the request length covers multipart framing).
  A crash between row commit and put leaves a `processing` row without an object; the unattached sweep (a later media ticket) removes it.
- `registerObject` (worker outputs) is not refused over quota: the provider work was already paid for; the next upload sees the usage.
- Found by the real-database test: PostgreSQL checks the proposed row of an upsert against `bytes_used >= 0` before the conflict, so a negative
  delta cannot be an upsert; `addUsage` creates the row empty and then updates.
- Files outside the listed paths, forced by the ticket's own report flags: `apps/api/vitest.config.ts` and `apps/api/package.json`
  (`reports/media-core` junit and lcov, coverage include/excludes). `api.module.ts` carries one import line plus one entry in `imports`.
- The worker composition root is not touched (not in the allowed paths); its StoragePort binding (token B) belongs to the sweep/sanitize tickets.
- Pre-existing, unrelated: `pg_dump` is not installed in this sandbox (see TASK-039 notes).
