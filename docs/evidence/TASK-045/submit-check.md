# TASK-045 submit check (usage 2/2: abuse thresholds, alerts, aggregate)

- `apps/api/src/modules/usage/application/abuse.ts`: `AbuseMonitor.checkAbuseThresholds(ownerId)` raises `job_burst` (more than `JOB_BURST_ALERT_COUNT`=20 jobs in `JOB_BURST_WINDOW_MIN`=10) and `provider_auth_spike` (`PROVIDER_AUTH_SPIKE_COUNT`=5 or more 401/429 in the window) through `AlertPort`; counts only. Provider 401/429 responses are reported with `noteProviderAuthResponse` (in-process window; no table exists for them in M0006).
- `application/aggregate.ts`: `UsageAggregator.aggregate(windowDays = 30)` per account (user id) and provider; max 366 days, else 422 `report_window_too_large` naming the limit; empty window returns `rows: []`.
- Wired in `usage.module.ts` (providers and exports; thresholds from env). `AlertPort` is resolved lazily from the app, since the audit module is registered by the composition root.
- Tests: `application/abuse.test.ts` (unit); `abuse.integration.test.ts` through `createApiApp` on real PostgreSQL (TC-ALR-01..03, TC-USG aggregate, window limit).
- Checks run with `CI=1`: `pnpm --filter @shroomap/api lint`, `typecheck`, `test:unit`, `test:integration` (27 files, 293 passed, 1 skipped), `scripts/ci/layers.sh`, `contract.sh`, `sast.sh`, `deps.sh`, `secrets.sh`; junit and lcov copied to `apps/api/reports/usage-abuse/`.
- Note: the ticket's allowed paths exclude `index.ts` and the repository, so the SQL sits in the two application files (as `identity` stores do) and the new services are not re-exported from `index.ts`.
