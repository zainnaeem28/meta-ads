# TASK-054 evidence

- `reports/deps.sarif` is read in place of the `reports/deps.json` the ticket names (as in TASK-044 and TASK-053).
- Each pnpm script is its own `--check` (`lint`, `typecheck`, `test:unit`, `test:integration`), run with `CI=1`.
- Test files: `application/qc-wer.test.ts`, `qc-run.job.test.ts`, `qc-config.test.ts`, `infrastructure/openai-transcribe/*.test.ts` (unit); `application/qc-api.integration.test.ts` (API-064 through `createApiApp` and `fastify.inject` on PostgreSQL) and `application/qc-worker.integration.test.ts` (the worker root `createWorkerApp`, real PostgreSQL, TLS stand-ins for the providers, fake `ffmpeg`/`ffprobe` on the PATH).
- The full machine report is attached to the task as `submit-check`.

## Round 1 finding F-1 (TASK-053's `production-worker.integration.test.ts` flakes)

Not caused by TASK-054. Reproduced with 8 busy-loop processes on the 4-core host, that file run alone, 5 runs each:
- `origin/dev` @ 5989595 (no QC code at all): 3 of 5 failed (a poll count `statusReads` of 2 in TC-PCA-01; `events` empty in the refused-submit test).
- this branch with the QC recovery hooks and the first-QC hook disabled: 2 of 5 failed, the same assertions.
- this branch as submitted: 2 of 4 failed (TC-PCA-01, TC-PCA-03 `statusReads`).
The assertions are fixed-delay timing checks (`setTimeout(500)`, counted provider reads) that fail whenever the host is busy; they pass in quiet runs on both. The file is TASK-053's and outside this ticket's paths: raised with the Orchestrator.

Recheck (commit bc2416e, `origin/dev` @ e7729e5 merged): `production-worker.integration.test.ts` alone, 5 runs on a quiet host: 4 passed, 1 failed (refused-submit test). Two full `test:integration` runs: the first failed once in TASK-059's `account-lifecycle.integration.test.ts` (`step` 4 instead of 2, a concurrent worker advancing the run; passes 3 of 3 alone), the second failed in TC-PCA-01 (`statusReads` 2 instead of 1: the test sends `production.poll` for a `submitted` job with `next_poll_at` already due while a 1200 ms file delay is in flight, so the periodic sweep's own poll races the test's). Both are fixed-delay races in other tickets' files; TASK-054 suites pass in every run.
