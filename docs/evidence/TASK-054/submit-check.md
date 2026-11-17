# TASK-054 evidence

- `reports/deps.sarif` is read in place of the `reports/deps.json` the ticket names (as in TASK-044 and TASK-053).
- Each pnpm script is its own `--check` (`lint`, `typecheck`, `test:unit`, `test:integration`), run with `CI=1`.
- Test files: `application/qc-wer.test.ts`, `qc-run.job.test.ts`, `qc-config.test.ts`, `infrastructure/openai-transcribe/*.test.ts` (unit); `application/qc-api.integration.test.ts` (API-064 through `createApiApp` and `fastify.inject` on PostgreSQL) and `application/qc-worker.integration.test.ts` (the worker root `createWorkerApp`, real PostgreSQL, TLS stand-ins for the providers, fake `ffmpeg`/`ffprobe` on the PATH).
- The full machine report is attached to the task as `submit-check`.
