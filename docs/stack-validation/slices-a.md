# Stack validation steps 3 to 5: auth, API and worker slices

Draft section of the `stack-validation` document (ARCHITECTURE §1.10 steps 3, 4 and 5). Ticket TASK-003 (AIU-76). Proof output: `docs/evidence/TASK-003/slices.txt`; JUnit: `reports/foundation/slices-a-junit.xml` (submit-check report on AIU-76).

## Setup

| Item        | Value                                                                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run command | `CI=1 pnpm --filter foundation-tests test:slices-a` (25 tests, about 12 s; needs `apps/api` and `apps/web` built with `pnpm build`)                                                                                                                                                            |
| Server      | the shared test PostgreSQL; each run provisions its own database and roles through `tools/foundation-tests/db/harness.ts` and drops them (leftovers `[]`)                                                                                                                                      |
| Clerk       | none. `clerk-fake.ts` serves the JWKS and the Backend API calls the slice uses (`users`, `sessions`, `invitations`) on a local port; the real `@clerk/backend` 3.29.0 `verifyToken` and `createClerkClient({ apiUrl })` talk to it. No Clerk account, key or instance was requested or awaited |
| API         | `app.ts`: real Fastify 5.12.8 + Drizzle 0.45.4 + `pg` as `app_api`. It stands in for the Nest API's behaviour (it is not product code); the product API is a later ticket                                                                                                                      |
| Worker      | pg-boss 12.38.2, queues created by `jobs-migrate.ts` under `app_migrator`; runtime as `app_api` and `app_worker` with `migrate:false, createSchema:false` and DML-only grants                                                                                                                  |

## Step 3: auth slice (local JWKS fake)

| Claim                                                                                                                                                                                                                       | Result                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Bearer verification: missing, malformed, foreign-key, wrong `azp` and expired tokens are 401; 3 s past `exp` is accepted (5 s skew)                                                                                         | pass                                                            |
| First admin linked from `OWNER_EMAIL` (verified address, case-insensitive) once; other addresses, an unverified address and a second claimant get 403 `account_not_active`; 4 concurrent claimants create exactly one admin | pass                                                            |
| `fva` semantics: `mfaSatisfied = fva[1] >= 0`; `recentAuth` within 10 min, second factor too when required for the actor (9 direct cases, 3 through the API)                                                                | pass                                                            |
| Reverification: stale `fva` gets 403 `recent_auth_required`; a token with fresh factors then succeeds                                                                                                                       | pass                                                            |
| MFA not bypassed: a first-factor-only token gets 403 `mfa_required` on every admin route                                                                                                                                    | pass                                                            |
| Invitation create with `expiresInDays: 7` (recorded `expires_in_days: 7` in the Backend API body) and revoke; second revoke 404                                                                                             | pass                                                            |
| Session revoke: an unexpired token is refused on the next request; user delete removes the row and the Clerk user and ends its sessions                                                                                     | pass                                                            |
| TR-08, L-1, D-S2 on a real Clerk development instance; real invitation delivery and expiry; Clerk Pro "require MFA"                                                                                                         | **NOT_RUN**, deployment-time owner item DOP-OI-4 (never a pass) |

Findings: in `@clerk/backend` 3.x a session token header must carry `cat: "cl_B7d4PD111AAA"` or `verifyToken` throws "Invalid session token category"; `verifyToken` throws on failure and returns the payload otherwise. Because verification is networkless, a revoked session is only seen by the API through a Backend API session check (the slice does it on each request); the real-Clerk latency of this check is part of the NOT_RUN L-1 row. `createInvitation` is called with `notify: false` in the slice; whether the product wants Clerk's email is a product decision.

## Step 4: owner-scoped CRUD on real PostgreSQL

Envelope (`{data}`, `{data, meta.nextCursor}`, `{error:{code,message,requestId}}`), `Location` and `ETag` on create, validation 400, 401 without a token (pass). 404 concealment: another owner's id and a missing id give the same body for GET, PATCH and DELETE, the record is untouched (pass). `If-Match`: 428 without it, 412 when stale, 200 with version +1 when current, four racing writers give one 200 and three 412 (pass). Cursor paging: 3 pages of 2 over 5 rows with no duplicates or gaps, other owner sees none, malformed cursor 400 (pass). `app_api` gets 42501 on `CREATE TABLE` in `public` and `pgboss` and on `DROP TABLE` (pass).

## Built artifacts and the one-path slice

The built `apps/api/dist/main.api.js` answers `GET /health/live`; the built web standalone server returns `/` 200 and an unknown route 404 with a robots `noindex` meta (TC-AUT-11, partly). In the same run, a Bearer `POST /v1/campaigns` through the slice API creates a row in PostgreSQL owned by the linked admin (web artifact, then REST, database, auth).

**Limits, recorded NOT_RUN and not a pass:** the web app has no page that calls the REST API yet and no browser is installed here, so the "UI" leg is the built web artifact serving, not a browser-driven flow; TC-AUT-11's "Go Home" action and the signed-in campaign list on `/` need the web tickets; the TC-ACC first-admin form (UI) is likewise web work, and its API rule (first admin from `OWNER_EMAIL`) is proven above.

## Step 5: worker slice

| Claim                                                                                                                                                                                                                | Result |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `send({db})` inside a Drizzle transaction: rollback leaves 0 jobs and 0 rows; commit leaves 1 and 1 (job is visible inside the transaction)                                                                          | pass   |
| `retryLimit: 0`: a throwing handler runs once; job `failed`, `retry_count` 0                                                                                                                                         | pass   |
| `expireInSeconds: 3`: a fetched, never completed job is failed by supervision, not retried                                                                                                                           | pass   |
| `singletonKey` (queue policy `short`): same key returns `null`, another key is accepted                                                                                                                              | pass   |
| Graceful drain: `stop({graceful:true})` waits for the running handler, job `completed`                                                                                                                               | pass   |
| Counted per-user claim (`INSERT ... ON CONFLICT DO UPDATE ... WHERE active < N`): 10 concurrent claims with limit 3 give 3 winners, release frees one slot, users are independent, a rolled-back claim leaves no row | pass   |
| `app_worker` has only USAGE and DML on `pgboss` (42501 on `CREATE`); queues come from `jobs:migrate`                                                                                                                 | pass   |

## Change requests

The allowed paths do not include the files that make a second workspace package resolve: `pnpm-workspace.yaml` (adds `tools/foundation-tests/slices`) and `pnpm-lock.yaml` (the importer entry). Both packages are named `foundation-tests` so that `pnpm --filter foundation-tests test:slices-a` runs the slices package only (the db package has no such script).
