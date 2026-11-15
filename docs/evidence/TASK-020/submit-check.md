# TASK-020 (AIU-80) platform/config evidence

Implements ARCHITECTURE section 6 in `apps/api/src/platform/config/`.

## What was built

- `registry.ts`: every key of section 6 for the api, worker and release processes, with type, the processes that
  read it, the processes that require it, default and class (public or secret).
- `schema.ts`: `validateConfig(kind, env)` builds one Zod schema per process, applies the registry defaults to the raw
  environment (so a default is validated exactly like a configured value), then runs the cross-key and APP_ENV rules.
  The result carries key names and a fixed fault word (`missing`, `invalid`, `forbidden`), never a value.
- `startup.ts`: `loadConfigOrExit(kind)` writes `config error (<process>): <KEY> is <fault>` per fault to stderr and exits 78.
- `env-source.ts`: the process environment only; `.env.local` is read only when `APP_ENV=development`; `.env` is never read.
- `compliance-register.ts`: the vendors whose data contract is recorded (empty). `PROVIDER_DATA_MODE_<OPENAI|WAVESPEED|SHOTSTACK>`
  defaults to `synthetic`; `real` exits 78 until the vendor is listed. An unknown `PROVIDER_DATA_MODE_*` key is refused.
- `main.api.ts` calls `loadConfigOrExit('api')` before Nest starts and listens on `API_PORT`.

## Acceptance mapping

| Acceptance | Proof |
| --- | --- |
| One startup test per required key (exit 78, key only, no value) | `schema.test.ts` (unit, per process and key, missing and invalid) and `startup.integration.test.ts` (built `dist/main.api.js` spawned once per required api key, on a uniquely named database of the shared test PostgreSQL) |
| Every owner-register default in the schema, validated, overridable | `schema.test.ts` "owner-register defaults (table test)": OI-CAPS, OI-ASM, OI-DOMAIN, OI-RET, OI-ADMIN, MFA_REQUIRED_FOR, ACCESS_REQUEST_FORM_ENABLED |
| `PROVIDER_DATA_MODE_*=real` refused without a recorded contract | `data-mode.test.ts` (TC-NFR-09) |
| Wired and proven through the real entry point | `startup.integration.test.ts`: valid config answers `/health/live`; each missing key exits 78 |
| Per-process secret sets | `schema.test.ts` "per-process secret sets": api refuses `KEK_PRIVATE_KEYS` and ledger tokens, worker refuses peppers and `CURSOR_SIGNING_KEY`, release refuses runtime secrets |

## Decision log (owner: Solution Architect review requested)

| Question | Choice | Reason |
| --- | --- | --- |
| Where does the "compliance register" live at startup? | A reviewed constant list in `compliance-register.ts`, empty today | No CREG runtime source exists; fail-closed default, change is a reviewed commit |
| Defaults for `OPENAI_TEXT_MODEL`, `OPENAI_VISION_MODEL`, `OPENAI_IMAGE_MODEL` | None (optional) | Section 6 says "resolved in stack validation" and names no concrete value; inventing one is not allowed. The usage module's price check (TD-D39, separate ticket) owns the check that a model exists |
| `R2` token distinctness between api and worker | Not checked | Needs a hash supplied by DevOps (VERIFY in section 6); the worker-side ledger-vs-token-B check is implemented |
| `ACCESS_REQUEST_FORM_ENABLED=true` requires Clerk sign-up mode public | Not checked at startup | Needs the identity adapter (later ticket) |
| `SENTRY_*`, `HEARTBEAT_URL_WORKER`, `METRICS_TOKEN` | Secret-class keys are refused outside their processes | Follows section 6 classes |
| Worker entry point | Schema exists (`validateConfig('worker', ...)`); no `main.worker.ts` exists on dev, so the worker call site belongs to the ticket that creates it | Out of allowed paths |

## Changes outside the allowed paths (necessary, flagged for the reviewer)

- `apps/api/package.json`, `apps/api/vitest.config.ts`, `apps/api/vitest.integration.config.ts`, `pnpm-lock.yaml`: the required
  command needs the `lint`, `test:unit` and `test:integration` scripts and vitest with coverage in `@shroomap/api`.
- `apps/api/src/main.api.ts`: the wiring (startup validation, `API_PORT`).
- `tools/foundation-tests/api-env.ts`, `foundation.test.ts`, `slices/slices-a.test.ts`: both start the built api; it now
  exits 78 without a complete configuration, so they pass a throwaway valid one (`PORT` is replaced by `API_PORT`).
- The deps report named `reports/deps.json` in the ticket is produced as `reports/audit.json` and `reports/deps.sarif`.

## Checks

The submit_check report is attached to the task (`submit-check` document).
