# TASK-104: FLOW-01 end to end (enter inputs and resume)

TC-FLW-01 and the FLOW-01 paths of UI-UX §7, on the built web app (`next build` then `next start`) against the built api and
worker (`apps/api/dist`), a throwaway database on the shared test PostgreSQL, a real MinIO server and a local TLS server
standing in for api.openai.com. Run it from `apps/web`:

```bash
REPORT_DIR=reports/flow-01 pnpm exec playwright test --config tests/e2e/flow-01/playwright.config.ts --project=chromium
```

(`pnpm --filter @shroomap/web build` is not needed: the config builds the web app itself. `pnpm --filter @shroomap/api build`
must have run.) The ticket's literal command, `pnpm exec playwright test apps/web/tests/e2e/flow-01 --project=chromium` from the
repository root, cannot find a configuration (the root has none and `@playwright/test` is a dependency of `apps/web` only), and a
root `playwright.config.ts` is outside this ticket's allowed paths; the configuration lives in the test folder instead.

## What runs for real, what does not

| Part | Real | Note |
| --- | --- | --- |
| Web app | Built artifact, `next start` | `NEXT_PUBLIC_API_ORIGIN` baked in; local session cookie as in `AUTH_MODE=local` |
| Api | `createApiApp` (the root `main.api.ts` runs) from `apps/api/dist`, listening on a port | In the Playwright process, not a child process (see F3) |
| Worker | `createWorkerApp` from `dist`: media sanitising, image analysis, brief generation | Same process |
| Database | Shared test PostgreSQL, one database per run, every migration's tables as written | Grants are proven by the migration suites; the roles do not exist on the shared server |
| Object storage | Real MinIO (checksum-verified binary) | |
| Provider | Local TLS server with the OpenAI answer shapes; the real provider is never called | The egress allow-list, TLS and key custody are the real code |
| Session | The api's local identity provider mints the token; the test adds it as `Authorization` at the network layer | The web app sends no bearer in local mode (F3) |
| Injected faults | Three, each named in its test: a 503 on one draft save (`failNext`), the provider stub failing, an expired token | Everything else is the api's own answer |

FFmpeg: the FLOW-01 journey does not assemble video, so no FFmpeg adapter runs here; TC-FLW-04 owns that.

## Tests (apps/web/tests/e2e/flow-01/flow-01.spec.ts), each at 390 px and 1440 px

| Test | Covers |
| --- | --- |
| TC-FLW-01 | SCREEN-005 empty, New brief, steps 1 to 4, autosave and the draft id in the URL, image upload (API-030, 031), analysis (API-035, 036), values and image persisted in the database, back to the Drafts list, resume at step 4, Generate brief (API-024), SCREEN-007 generating then the generated brief, the submitted draft read-only. Screenshot and axe at every step |
| validation errors, back | Validation summary keeps the step; Back keeps the values; the draft carries the step |
| save failure | Values kept, error notice, Try again saves (503 injected on the autosave) |
| stale save | A newer version saved elsewhere gives the conflict state; nothing overwritten; Reload latest version |
| session ended | Real 401 from the api; dialog names the step; Sign in again carries `return=/campaigns/new?draft=<id>`; the draft resumes at the same step |
| upload rejected | A file that is not an image (api, 415) and an undecodable PNG (worker, `decode_failed`): reasons shown, no image attached, the step still completes |
| analysis fails | Provider failure: failure notice, no description, the typed description kept |
| start over | Cancel keeps the draft; Start over deletes the draft; the old link shows the unavailable state |
| permission | Another operator gets "not available" for the draft (owner concealment); an operator without an OpenAI key gets the key-missing state and no campaign is created |
| brief fails | Provider failure after Generate: the failed state, no Accept brief, never a brief |
| keyboard only | NFR-07: the journey from the list to the brief with the keyboard (the native file chooser is the one step Playwright drives with `setInputFiles`) |
| F2, F1 (expected to fail) | The two mismatches below, written as `test.fail` so they pass while the defect exists and fail the day it is fixed |

Axe (WCAG 2.2 A and AA, every impact, not only critical) is clean on every captured step: `docs/evidence/TASK-104/axe/`.

## Mismatches found (the owners' paths are outside this ticket)

| ID | Severity | Where | What happens | Owner |
| --- | --- | --- | --- | --- |
| FLOW01-F1 | Blocker | `packages/contracts/src/http.ts` (`credentials: 'include'`) against `apps/api/src/platform/http/cors.ts` (`credentials: false`, ARCHITECTURE 1.8 and TD-D40) | A browser refuses every api response from the web origin: "The value of the Access-Control-Allow-Credentials header ... must be 'true' when the request's credentials mode is 'include'". The api is bearer-only, so the generated client should not send credentials. The tests add the header at the network layer so the rest of the flow can be proven; with `FLOW01_CORS_WORKAROUND=0` every call fails | TASK-019 (contracts mutator) or TASK-023 (cors) |
| FLOW01-F2 | High | SCREEN-006 steps 3 and 4 (TASK-089, TASK-091) against API-024 | The api refuses to submit a draft without `direction.segmentCount` (400 `validation_failed`, field `direction.segmentCount`); step 3 does not require it and offers no default, and step 4 has no control for the field. The person sees "Check the highlighted fields and try again" with nothing highlighted and no way to learn that step 3 needs a choice. Either require the segment count on step 3 or map the field and send the person to step 3 | TASK-089 / TASK-091 |
| FLOW01-F3 | High | `apps/web/src/providers/app-providers.tsx` (no Clerk key gives `getToken` = anonymous) against the api's local identity | In `AUTH_MODE=local` the web app signs the person in with its own cookie but sends the api no bearer, and the api in `IDENTITY_MODE=local` only accepts tokens signed by its in-process key pair, which nothing outside the api process can mint. RUN-GUIDE describes the local stack as usable end to end; every protected call would answer 401. The tests run the api in-process to reach its identity port and add the bearer at the network layer | Web providers (TASK-082) and identity (TASK-033): a local-mode token path |
| FLOW01-F4 | Low | `NewBriefWizard` autosave (800 ms debounce) | Leaving the page within 0.8 s of the last keystroke drops that edit (no flush on leave). The tests wait for the autosave before leaving | TASK-091 |
| FLOW01-F5 | Info | Mock fixtures of TASK-092 | The image-analysis fixture says "A white bottle of 60 capsules", but `white` is on the sensitive-attribute list (`config/brand-rules.json`), so the real worker drops that sentence and the analysis fails as "No usable description". The real run uses "A glass bottle ..." | Fixture owner |

## Files

- `apps/web/tests/e2e/flow-01/`: `playwright.config.ts`, `global-setup.ts`, `stack.ts` (the stack), `support.ts` (session, PNG, helpers), `flow-01.spec.ts`.
- `docs/evidence/TASK-104/screenshots/`: one PNG per step at 390 and 1440 px (real fonts). `axe/`: the axe results of each.
- `docs/evidence/TASK-104/submit-check.md`: the submit-check report.

## Tracking, limits and exceptions (review round 1 response)

- **Owner tasks:** F1 to F4 and the `NewBriefWizard.test.tsx` flake (L2, TASK-091) are tracked by AIU-271 (the Orchestrator creates one owner task per defect and records the IDs on AIU-177). The `test.fail` annotations in `flow-01.spec.ts` reference AIU-271.
- **Integrated evidence is conditional on F1 and F3:** TC-FLW-01 passes only with two network-layer workarounds in `support.ts` (the added `access-control-allow-credentials` header and a minted bearer). Until F1 and F3 are fixed in their owner tickets, it proves the screens, data and state carried between steps, not an unaided browser-to-api call. QA reuse of this test must carry this limit.
- **Exception:** `.gitleaksignore` is outside the allowed paths; it holds fingerprints for earlier commits only (branch name text and an old fake test key, no credentials).
