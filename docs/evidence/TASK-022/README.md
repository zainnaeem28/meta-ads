# TASK-022 (AIU-90) platform/http 1/2 and shared-kernel

Implements ARCHITECTURE 3.1, 3.2, 3.5, ADR-010 and ADR-011 in `apps/api/src/platform/http/` and
`apps/api/src/platform/shared-kernel/`.

## What was built
- `domain-error.ts`: `DomainError(code, safeMessage, details?)` bound to the 36-code registry (`ERROR_STATUS`, one status each; message <= 500, details <= 50, detail message <= 300).
- `response.ts`: success/error envelopes, `PageResult` (pagination in `metaData`), `CsvResult`, `RawResponse`, `EnvelopeInterceptor` (204 and CSV without envelope).
- `error.filter.ts`: one global filter: DomainError, Nest HttpException and Fastify errors to the envelope; SQLSTATE 57014/55P03 (also on `cause`) to 503 `service_unavailable`; unknown to 500 `internal_error`; every 5xx logged once with the request ID and never carries `details`.
- `validation.pipe.ts`: `ZodValidationPipe`/`parseWith`; 400 `validation_failed`, `details[]` max 50, camelCase DTO paths, fixed messages (the rejected value is never echoed).
- `cursor.ts`: HMAC-SHA-256 signed cursor over owner, sort key, filter hash, 24 h expiry; `buildPage` (fetch limit+1).
- `shared-kernel`: UUIDv7 ids, `Result`, `DomainErrorBase`.

## Acceptance mapping
| Acceptance | Proof |
| --- | --- |
| Each of 36 codes gives its registry status and envelope (TC-ERR-08); table equals generated `ERROR_CODES` and the openapi status comments | `http.test.ts` "registry" |
| Statement timeout and lock timeout give 503 | `http.test.ts` (SQLSTATE) and `http.integration.test.ts` (real `pg_sleep` with `statement_timeout`, real `LOCK TABLE` with `lock_timeout`) |
| Tampered, expired, other-owner, other-filter cursors rejected; N and N+1 rows give two pages, no repeat/gap | `cursor.test.ts`, `http.integration.test.ts` (11 rows on real PostgreSQL) |
| Never 200 with `success:false`; 5xx has no `details[]` | `http.test.ts` |
| Through the real entry point | `http.integration.test.ts` runs the built `dist/main.api.js` (404 envelope, bad JSON 400, request ID echo, raw probe) |

## Decision log
| Question | Choice | Reason |
| --- | --- | --- |
| Import `@shroomap/contracts` at run time? | No; `ERROR_STATUS` lives in the api and a unit test compares it with the generated `ERROR_CODES` and the openapi status comments | The contracts package ships TypeScript source (extensionless imports), which node cannot load from `dist`, and it is not an api dependency |
| Missing vs wrong-type detection | Walk the original input at the issue path | Zod 4 omits `issue.input` by default, so every invalid_type looked like "required" |
| Health probe | `@RawResponse()` keeps `/health/live` unwrapped | Probes are not API responses |
| Messages for non-Domain errors | Fixed text per code | Exception text may carry internals |

## Change requests (outside allowed paths, minimal edits)
- `apps/api/src/main.api.ts`: registers `ErrorFilter` and `EnvelopeInterceptor` globally; `/health/live` is `@RawResponse()`.
- `apps/api/vitest.config.ts`: coverage includes `platform/http` and `platform/shared-kernel`, reports to `reports/http`, junit also to `reports/http/junit.xml`.
- Report flags: the repo's scanners write `reports/deps.sarif` and `reports/audit.json`, not `reports/deps.json`.
