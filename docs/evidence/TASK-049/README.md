# TASK-049 brief 2/4: evidence notes

- **TextAIPort** (`application/worker/text-ai.port.ts`) and its one adapter `infrastructure/openai-text-ai.ts`: `generateBrief`, `shortenSegments`,
  `describeProduct` over OpenAI chat completions through `platform/egress` (`EGRESS`, allow-listed host, pinned address, 1 MB answer bound). Structured
  output (`response_format: json_schema, strict`), `store: false`. A body that is not JSON, a refusal, or JSON that fails the zod schema is
  `ProviderInvalidResponse` (the call was made: usage `failed` at the estimate, job `failed` `temporary`). HTTP and transport failures are classified by
  `classifyProviderFailure` / `classifyEgressFailure` (ARCHITECTURE §5.10): 401/403 configuration (401 counts toward the key), 402 and 429
  `insufficient_quota` credit, other 429 and 400/422 temporary (rejected, zero), 5xx and timeout after send `outcome_unknown` (unconfirmed estimate),
  refused or DNS before send temporary (no event). Image bytes go inline as `data:<type>;base64,...`; no URL is built for the image (TD-D26).
- **`brief.generate`** (`brief-generation.job.ts`): gate (job pending, campaign and brief present, key row = job `key_id`/`key_version`, not disabled, claim
  rules loaded) then `UsageService.reserve` (idempotent; the cap check under `spend:{owner}` when the api did not already create the reservation), then the
  claim (`pending` to `submitting`, committed before any call), then call 1; `finalize` removes dashes and forces the exact CTA in the last segment; a
  segment over 45 words triggers call 2 (`call_seq 2`); what is still over 45 is trimmed and raises `word_count_trimmed`; `checkBrief` + `reconcileIssues`
  decide issues to close and raise; segments are written in place (`revision + 1`), the brief goes `draft` (`version + 1`), the job `completed`, the
  leftover reservation is released, all in one transaction. A failure ends the job `failed`; the brief goes `failed` (no previous text) or back to `draft`
  (regeneration keeps its text, SB-D11).
- **`brief.analyze-image`** (`image-analysis.job.ts`): same gates (media `ready`, owner's, key), image read from storage with the worker's token, one call,
  output `{productDescription}` filtered by `dropSensitiveSentences` with the `sensitiveAttributeFilter.terms` of `config/brand-rules.json`; nothing left,
  malformed answer or any failure: job `failed` `temporary`/cause class, no description, the owner continues (REQ-006). Result in `brief_jobs.result_text`.
- **Key custody**: the key row is read by key ID in the worker (`DrizzleBriefJobs.findKey`), opened by `KeyOpener` which `worker.module.ts` binds to the
  `KeyUnsealer` it alone may import (layer rule L3), passed to the adapter as a `Buffer` and zeroed in `finally`. 401 results are reported to
  `DrizzleKeyAuthReporter` (same transitions as `ProviderKeysService.recordAuthResult`, which the worker process does not carry: count, `auth_failed` and
  `disabled` events, audit entry at `KEY_AUTO_DISABLE_THRESHOLD`; a success resets and activates `untested`). No key, request or provider body reaches a
  log, a job row, a queue payload or an error message (asserted in the integration test).
- **Wiring** (`bootstrap/worker.module.ts`, more than the one import line the ticket lists, because the worker had no usage or egress module and the
  unsealer had to be shared): `BriefModule.registerWorker(env, {audit, egress, usage, opener, storage})` when the key custody (`KEK_PRIVATE_KEYS`), object
  storage (`R2_ENDPOINT`) and both models (`OPENAI_TEXT_MODEL`, `OPENAI_VISION_MODEL`) are configured, with `UsageModule.register(env)` (its start-up price
  check then covers the two models) and `EgressModule.register(config)`; handlers `brief.generate` and `brief.analyze-image` join the handler map. Two test
  seams only: `WorkerOptions.egress` and `WorkerOptions.openAiChatUrl` (the product never sets them). `WorkerConfig` gained the three optional egress fields.
- **Proof through the real entry point**: `brief-ai.integration.test.ts` runs `createWorkerApp` (the root `main.worker.ts` runs) on real PostgreSQL (each
  migration's tables as written, owner connection) and a real MinIO, a local TLS server standing in for api.openai.com, a pg-boss job sent from an api-role
  boss and handled by the worker process. Covered: generation and write-in-place, two-call shortening, 401/429/credit/5xx/timeout/malformed mapping with
  usage events and reservations, regeneration failure keeps text, missing/replaced/disabled key (no call, no charge), cap refusal before any adapter call,
  at-most-once on a repeated job, image analysis with a person fixture (no ethnicity, age or health inference), bytes sent inline, 401 counting and
  disabling the key. TC-BRF-*, TC-UPL analysis cases, TC-PCA.
- **Unit tests** (`jobs.test.ts`, `post-process.test.ts`, `openai-text-ai.test.ts`, `storage-image-source.test.ts`): ordering (reserve, claim, adapter),
  every outcome's usage settlement, key guards, key zeroed after use, adapter schema/class mapping against a local TLS server.

Not in this ticket (noted for the owners): the orphan sweep hook for `brief_jobs` (a crash between claim and answer leaves `submitting`; the generic sweep
and the hook are the recovery-sweep owner's), `provider_auth_spike` alert counting, and job creation at the api (brief 3/4).

Files outside the allowed paths (needed, append-only, same precedent as TASK-048): the `reports/brief-ai` junit entry and the coverage excludes of the two
integration-proven repositories in `apps/api/vitest.config.ts`, and the `reports/brief-ai` lcov copy in `apps/api/package.json`.

Full-suite note: `test:integration` run as one suite showed `observability` and `logging` integration tests (they spawn the built api and share ports)
failing once under load; both pass when run alone (23 tests) and neither touches code changed here.
