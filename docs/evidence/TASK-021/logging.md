# TASK-021 (AIU-86) platform/logging evidence

Implements ARCHITECTURE 1.6 (XI), 3.1 and 3.7 in `apps/api/src/platform/logging/`.

## What was built

- `logger.ts`: pino 10 JSON to stdout; `releaseSha` base binding on every line; ISO `time`; level label; allow-list and
  value scrubbing in `formatters.log`, a `child` wrapper (pino resets the bindings formatter for children), and a
  `logMethod` hook that scrubs the message. `runLoggedJob`/`jobLogger` give the worker path: `jobId`, `jobType`,
  `correlationId`, `outcome`, `code`, never the error object.
- `allow-list.ts`: the 18 fields of 3.7; unlisted names and non-primitive values are dropped.
- `redact.ts`: pino redaction paths of 3.7 (belt and braces behind the allow-list), shape scrubber (OpenAI `sk-`,
  WaveSpeed-style `ws_`/`wavespeed_`, bearer values, JWTs, emails, signed URLs, Clerk keys), literal scrubber for every
  configured secret value and for credentials learned from request headers, deep scrubbers for error-reporter events
  (`scrubReportEvent`, a Sentry `beforeSend`) and tracing attributes (`scrubSpanAttributes`).
- `request-id.ts`: UUIDv7 unless an upstream value matches `^[A-Za-z0-9-]{8,64}$`; `responseMeta()` is the
  `metaData` shape for the http layer; `withCorrelation`/`correlationOf` carry the ID in job payloads.
- `logging.module.ts`: `createHttpLogging()` returns the Fastify adapter (owns request IDs, echoes `X-Request-ID`, one
  request line per response with the route template) and the nestjs-pino module as application logger.
- `main.api.ts` builds its adapter and module from `createHttpLogging()` (see change requests).

## Acceptance mapping

| Acceptance | Proof |
| --- | --- |
| Canary absent on api and worker paths; fails when redaction is disabled | `logger.test.ts` (TC-LOG-01: message, fields, error, child, job success and failure, reporter, trace; negative probe with `redaction: false` finds the canary), `logging.module.test.ts` (Nest/Fastify), `logging.integration.test.ts` (built `main.api.js`, header, cookie, URL, 404 path, configured secret) |
| Allow-list rejects an unlisted field; no email, token or key shape | `allow-list.test.ts`, `logger.test.ts` TC-LOG-03 |
| Request ID echoed in header and `metaData.requestId` shape | `request-id.test.ts`, `logging.module.test.ts`, `logging.integration.test.ts` |
| Wired and proven through the real entry point on real PostgreSQL | `logging.integration.test.ts` spawns `dist/main.api.js` on a uniquely named database of the shared test PostgreSQL |

## Decision log

| Question | Choice | Reason |
| --- | --- | --- |
| nestjs-pino request middleware | Not used; Fastify `onRequest`/`onResponse` hooks log the request line | Under Nest 12 + Fastify the middleware never ran (no request line even in a minimal app); the hooks are deterministic and log only template route, method, status, duration |
| Bare tokens with no recognisable shape | Credentials seen in `Authorization`/`Cookie` are learned as literal secrets (cap 1000); configured secret-class values are literal secrets | A shape scrubber cannot catch an opaque token |
| WaveSpeed key shape | `ws_`/`wavespeed_` prefix pattern | Real format is still VERIFY (TR-01); literal config values cover real keys once configured |
| Worker bootstrap | `runLoggedJob` + `buildLogger`, tested at unit level; no `main.worker.ts` exists on dev | The worker composition root belongs to a later ticket |

## Change requests (outside allowed paths, minimal edits made)

- `apps/api/src/main.api.ts`: uses `createHttpLogging()` (required by the "wired into the running product" acceptance).
- `apps/api/vitest.config.ts`: coverage now also covers `platform/logging`, reports to `reports/logging` (the ticket's
  `--coverage`/`--junit` paths); `reports/config/junit.xml` is still written.
- Report flags: the repo's scanners write `reports/deps.sarif` and `reports/audit.json`, not `reports/deps.json`.

## Review round 1 fixes
- F-1: `logMethod` now scrubs an Error passed as first argument (message and `{ msg }` objects); tests cover `log.error(err)`, `{ err }`, `{ msg }` and `runLoggedJob` with a throwing handler holding the canary.
- F-2: covered by the same test.
- F-3 (limitation): no `main.worker.ts` on dev; worker path is tested at unit level via `runLoggedJob` + `buildLogger`.
