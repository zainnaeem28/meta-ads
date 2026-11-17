# TASK-065 evidence: API conformance, authorization matrix and zero-trust suites on the running app

Run: `CI=1 pnpm --filter @shroomap/api test:conformance` (config `apps/api/tests/conformance/vitest.config.ts`, then the gate `scripts/ci/api-matrix.mjs`).
Reports: `apps/api/reports/conformance/junit.xml` (the matrix report the gate reads and QA reuses), `lcov.info` (the suite's own harness), `observed.jsonl` (every reply the suite saw), `api-matrix.json` (the gate's summary), `role-matrix.json` (operation x role, for the DAST baseline). The gate report is `submit-check.md` next to this file.

Everything runs through the real api composition root (`createApiApp`) with `fastify.inject`, the real worker composition root (`createWorkerApp`), real PostgreSQL, an in-process S3 stand-in and a local TLS server standing in for the OpenAI API (the stack of TASK-116). The 408 case runs against a listening server over a real socket. No real provider, no real identity vendor.

## How the matrix is made

`support/spec.ts` reads `packages/contracts/openapi.yaml` and generates one cell per operation (`x-api-id`) and documented status: 57 operations, 463 cells. `matrix.conformance.test.ts` runs a probe for every cell; a cell with no probe fails (`no probe for API-nnn sss`). A probe builds the state the cell needs (through the API, or SQL where the API cannot get there quickly), asks the operation through HTTP, and the test holds every reply to the contract:

- the status is the documented one, and the code is a registry code the operation may return with that status;
- the envelope is exactly `{success, data|error, metaData}`, `metaData.requestId` equals `X-Request-ID`, the instant is RFC 3339 UTC, the body validates against the response schema of the file (Ajv, 2020-12), no stack, SQL, path, key or token appears in an error, and `error.details[]` items are `{field, code, message}` with public field names (TC-ENV-01, TC-ENV-02, on all replies).

Shared causes are produced the same way for every operation: 401 (no token, bad token, Basic), 403 (unlinked identity, suspended, removed, no second factor, user on an administrator route, stale sign-in where enforced), 400 (the input the operation reads, made malformed), 404 (a missing record), 429 (the general limit used up in the current window), 500 (a column the account lookup reads is gone for one call), 503 (the rate-limit store is gone for one call). 902 and 903 are asked of the api root built with a metrics token and no database.

## Case map

| Case | Test file (`apps/api/tests/conformance/`) | What it proves |
| --- | --- | --- |
| TC-OPS-08, TC-ENV-01, TC-ENV-02 | `matrix`, `router`, `harness` | every operation x documented status passes (463 cells); every route of the running app is in the file and the reverse; the envelope and schema of every reply; the checker refuses a bad envelope |
| TC-ERR-08 | `envelope`, `scripts/ci/api-matrix.mjs` | the OpenAPI enum, the generated list and the status table are the same 36 codes; the gate fails when a registry code was never answered by the running app with the registry's status (35 by single requests, `last_admin` by a race) |
| TC-AUT-09, TC-AUT-06, TC-AUT-10 | `authorization` | every guarded operation x {anonymous, owner, another user, an administrator, suspended, removed}; no unguarded operation; users refused on every administrator route; suspended and removed refused on every operation |
| TC-AUT-01, 02, 03, 04, 05, 12, TC-ZT-03 | `authorization` | every operation that takes an owner's record id: another user and an administrator get the answer (status, code, message, details) of an id that never existed; the owner's rows are unchanged; the owner is not refused; search finds no foreign record; a foreign signed-URL request gets none; API-042 audits `access.denied_foreign` |
| TC-ZT-01, TC-AUT-13 | `zero-trust` | twelve forged shapes (alg none, HS256, foreign key, swapped payload, no signature, expired, not yet valid, wrong party, wrong issuer, no subject, empty, dots) on every guarded operation: 401, no state change |
| TC-ZT-02 | `zero-trust` | a user token with admin claims in six shapes, forged identity headers, a stale admin token after demotion: `forbidden_role` on every administrator operation |
| TC-ZT-04, TC-ZT-06 | `zero-trust` | SQL, wildcard and markup text in search, filter, cursor and limit; stored markup comes back as the same JSON text; extra fields (`role`, `owner_id`, `status`, `campaign_id`, `key_id`, `version`) on API-023, 051, 011, 104 are 400 and nothing is applied |
| TC-ZT-05 | `router` | preflight from another origin is 204 without `Access-Control-Allow-Origin`; from the web origin it is echoed with `Vary: Origin`; never `*`; no CSRF status; cookie alone is 401 |
| TC-ZT-07 | `edge` | nosniff, referrer policy, frame protection, no-store on every operation's replies, route misses included; HSTS only in production and staging |
| TC-ZT-08 | `edge` | 413 for an oversized upload with nothing stored; 429 with `Retry-After`; 408 written by the server, not enveloped, 60 to 95 seconds, over a real socket with a dripping body |
| 405, 404 (TD-D34, TD-D37) | `router` | every path template with every undeclared method, with no token, a good token and a bad token: 405 `method_not_allowed`, exact `Allow`, never 401; unknown paths 404 the same with or without a token |
| TC-ENV-03, 04, 05, 06 | `envelope` | public field names and detail codes; limit 0 and 51 and an invalid cursor; 51 records on five lists at limit 1, 20, 50, 51, a full walk, a tampered and a foreign cursor; health bodies; an oversized or malformed request id is replaced |
| admin-route denial with audit events (SECURITY-DESIGN §16) | `admin-denials` | a user on every administrator route: one `auth.denied` event per attempt naming the caller and the request, nothing else changed; no event for callers that name no account; allowed administrator actions audited; the `last_admin` race |
| the role table for the DAST baseline (§16.2, TC-ZT-12) | `authorization` | `reports/conformance/role-matrix.json`: status of every guarded operation for anonymous, user, administrator, suspended, removed |

## Wiring

The suite is wired into the product through `pnpm --filter @shroomap/api test:conformance` (script added to `apps/api/package.json`; see the change request below) and every case goes through the real composition roots: `createApiApp` (the root `main.api.ts` calls) and `createWorkerApp` (the root `main.worker.ts` calls) on real PostgreSQL.

## Files outside the allowed paths

- `apps/api/package.json`: one script, `test:conformance`, which the ticket's required check names. It runs the suite, then the gate.

## Findings

See `findings.md`. Two defects (CONF065-F1, CONF065-F5), one low defect (CONF065-F6), two contract gaps (CONF065-F3, CONF065-F4), one observation (CONF065-L1) and the open SEC116-F2 are held by tests; none is fixed here.

## Harness notes

- Probes for 500 and 503 break the account lookup or the rate-limit store for one call (a renamed column or table, restored in `finally`); the suite runs one file at a time against one database per file.
- The worker runs beside the suite. Row snapshots compare the job tables by count (only the api inserts them) and the other tables by content, so a job the worker advances does not read as a foreign change.
