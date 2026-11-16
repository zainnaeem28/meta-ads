# TASK-044 usage 1/2: evidence notes

- Migration `0050_task-044-usage.sql` (M0006 content, range 0050-0059), generated with `pnpm db:generate --name=0050_task-044-usage`:
  `usage_events` (no foreign keys, unique `(job_type, job_id, call_seq)`, outcome and cost-basis pairing check, `(owner_id, at)` and `(at)` indexes),
  `spend_reservations` (owner FK cascade, unique `(job_type, job_id)`, `remaining_calls >= 1`), `price_table` (PK `(provider, operation, effective_from)`).
  Grants: `usage_events` SELECT/INSERT (append-only history) and `spend_reservations` full DML to `app_api` and `app_worker`; `price_table` SELECT
  only (the release seed writes it as the owner role). Compensating SQL for the rollback check: `0050-compensating.sql` in this folder (the
  platform-owned fixture folder `tests/integration/migrations-check/fixtures/compensating` is outside this ticket's paths).
- `config/price-table.json` (versioned, `version: 1`) and `domain/price-table.ts`: the loader/validator (shape, real dates, no duplicate key) and
  `missingPrices()`, which `price-table.test.ts` runs over the file for the registry-default models, the local stub models and the vendor render
  (so the thumbstopper image model is priced). `priceTableSeedStep()` upserts the file by natural key; a rerun changes nothing (integration test).
- `UsageService`: `estimate`/`estimateOrRefuse` (row in force today, 503 `service_unavailable` plus an error log `price_missing` naming provider and
  operation), `checkCap` (daily and monthly UTC windows, recorded + reserved + new estimate, 422 `spend_cap_reached` naming the limit and the estimate
  basis), `reserve` (lock, idempotent per job, cap, insert), `record` (event on conflict do nothing, reservation reduced only when the event was new,
  `rejected` costs zero), `convertUnconfirmed` (same transaction, `unconfirmed` event keeps the estimate), `release`. Every state change takes the
  `spend:{ownerId}` lock first. Amounts are integer ten-thousandths of a dollar in code and `numeric` in SQL; no floating-point sums.
- Start-up price check (TD-D39): `StartupPriceCheck` runs at `onApplicationBootstrap`; missing row effective now -> stderr names provider and operation
  only, exit 78; any other failure (database unreachable, query failed) -> exit 1, no detail.
- Wiring: `UsageModule.register(process.env)` appended to `bootstrap/api.module.ts` when `DATABASE_URL` is set. Proof: `usage.integration.test.ts`
  builds the real api through `createApiApp` on real PostgreSQL, takes the service from it, and makes the start-up check fail for real (78 and 1).

Test mapping (TEST-CASES v3.3 defines TC-CAP-01..04 only): TC-CAP-01 cap at creation (exactly at the cap allowed, a cent over refused, recorded cost counts);
TC-CAP-02 UTC day and month windows by injected clock; TC-CAP-03 ten concurrent creations one job below the cap, one passes; TC-CAP-04 stub provider
never reached for a refused job; TC-THM-03 missing row 503 and start-up 78. TC-CAP-05..07 are named after this ticket's remaining acceptance lines:
record/convert idempotency and zero-cost rejection (05), unknown outcome conversion with a late response (06), rollback of event and reservation
together (07).

Decisions and notes for the reviewer:
- Operation key = the configured model id (`OPENAI_*_MODEL`, `WAVESPEED_MODEL_*`) or `shotstack-render`. The start-up check covers the operations the
  process's environment names; registry defaults are covered by the file validator test, not by the runtime check, because an api that carries no
  worker-only model keys would otherwise exit 78 on an unseeded database in every existing integration suite.
- `config/price-table.json` figures are estimates for the local stub models and the registry-default models; a reviewer replaces them with each
  provider's published price before the paid-call flag is enabled (owner item, default applied).
- Not done, outside the allowed paths: the worker composition root (`bootstrap/worker.module.ts`) does not register `UsageModule` yet, and the seed
  registry (`database/index.ts` `seedSteps`) does not append `priceTableSeedStep()` yet. Both are one-line appends for the Orchestrator to assign
  (the worker needs the module for record/convert/release and for the worker-side start-up check). `modules/usage/index.ts` (the module's public
  surface) was added because other modules may only import through it.
- Files outside the listed paths, forced by the ticket's own report flags: `apps/api/vitest.config.ts` and `apps/api/package.json`
  (`reports/usage` junit and lcov, coverage include and excludes).
- `reports/deps.json` named in the ticket does not exist; `scripts/ci/deps.sh` writes `reports/deps.sarif`, which the submit check reads instead.
- `pnpm db:check-history` (not in this ticket's required checks) fails 3 tests before and after this change for reasons unrelated to usage:
  `app_api lacks SELECT on public.provider_keys` (column-level grants of M0004) and a compensating-fixture set that stops at 0010.
