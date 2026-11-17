# TASK-060 reporting: usage report and CSV (API-130, API-131)

Evidence for the exact commit this file is committed with. The machine report of `submit_check.py` is attached to AIU-122 as
the `submit-check` document.

## What was built (`apps/api/src/modules/reporting`, layer 7)
- `usageReport(window)`: usage events (per account and provider, per provider; calls, outcomes, estimated cost, latency p50/p95),
  `production.jobStatsWindow(from, to)` (AIU-236) and `brief.claimCounts({from, to})` (AIU-235) composed read-only.
  The usage query runs under `SET LOCAL statement_timeout` 15 s; the two services each own their transaction, so they get the
  same 15 s as a timer. Any failing or slow source gives 503 `service_unavailable`, never zeros.
- API-130 `GET /admin/usage-report`: scope A plus recent authentication, 10 per minute per administrator, 422
  `report_window_too_large` above `REPORT_MAX_WINDOW_DAYS` (366) naming the limit, 400 for a bad or backwards window, empty
  state (`empty: true` with empty arrays), `asOf`, user IDs only.
- API-131 `GET /admin/usage-report.csv`: same window rules, 5 per minute, contract header, formula-injection prefix, audit event
  `usage_report.exported` (actor, outcome allowed; no content) written once the export is produced.
- Wiring: `ReportingModule` is registered in `bootstrap/api.module.ts`; the test goes through `createApiApp` (the root
  `main.api.ts` runs) with `fastify.inject` on real PostgreSQL.

## Decisions and deviations (for the reviewer)
1. `usage.aggregate(windowDays)` takes a day count ending now and returns average latency, so it cannot serve `from`/`to` or
   p50/p95. The report reads `usage_events` itself in `infrastructure/usage-report.reader.ts` (read-only aggregate, one pass with
   grouping sets). Counts, estimates and latencies only.
2. Rate limits are enforced in the controller with the platform `RateLimiter` (scopes `usage-report`, `usage-report-csv`), because
   named route limits are configured in `platform/rate-limit`, outside this ticket's paths.
3. `jobStates` carries the window counters of `jobStatsWindow`: `videoCreated`, `videoCompleted`, `videoFailed`,
   `videoCancelled`, `qcCreated`.
4. Anonymous and the old 16-digit key are not session tokens: 401 from the session guard. They have no account to attribute an
   audit event to (an audit event of type user/admin needs an actor ID); a signed-in non-admin and a stale-authentication
   administrator are audited (`auth.denied`).
5. Shared files touched, same pattern as earlier tickets: `apps/api/vitest.config.ts` and `apps/api/package.json` (the
   `reports/reporting` junit/lcov that the ticket's submit flags name); `bootstrap/api.module.ts` now builds the brief and
   production module instances once so reporting can import the same instances.
6. The ticket names `reports/deps.json`; `scripts/ci/deps.sh` writes `reports/deps.sarif` (osv-scanner) and `reports/audit.json`
   (pnpm audit), which are the files passed to `--findings`.

## Performance (TC-USG, 2 s budget at 150,000 events)
`apps/api/reports/reporting/perf.json` (ignored), written by `reporting.integration.test.ts` on the shared test PostgreSQL (150,000
`usage_events` over 50 accounts and 3 providers, 8 runs through HTTP): first run: p95 152 ms, max 152 ms (budget 2000 ms).

## Tests
`reporting.test.ts` (window, CSV), `usage-report.service.test.ts` (composition, empty state, 503 per source, window errors),
`reporting.integration.test.ts` (denials and audit, empty then populated report validated against the OpenAPI schema,
366-day limit and bad windows, CSV header and audit event, no-secret scan, 429 limits, 503 with a source taken away, 150k budget).
