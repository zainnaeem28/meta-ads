# TASK-061 evidence: health and observability instruments

- API-900/901 (`platform/health`), API-902/903 (`platform/metrics`, scope M, metrics-token guard), pool-wait metric, metrics-from-logs helpers (`MetricLines`), Sentry adapter with scrub hook (off until `SENTRY_DSN`).
- Tests: `platform/health/*.test.ts`, `platform/metrics/*.test.ts` (unit); `platform/health/observability.integration.test.ts` (built `dist/main.api.js`, real PostgreSQL, validated against `packages/contracts/openapi.yaml` HealthResponse / MetricsWindowResponse).
- Readiness: `select 1` within 1 s, config valid, not draining, pg-boss `isInstalled()` within 1 s, applied-migration count (`drizzle.__drizzle_migrations`) within `MIN_SCHEMA_HEAD`..`MAX_SCHEMA_HEAD` (environment, defaults 0..unbounded). Draining starts on a shutdown signal and lasts `API_DRAIN_SECONDS`.
- Changes outside the allowed paths (necessary): `bootstrap/api.module.ts` also loses the stub `HealthController`; `http/edge.test.ts` drops its fake metrics controller (the real one owns those routes); two integration assertions expect the enveloped HealthResponse; `vitest.config.ts` and `package.json` (`test:unit`) add the observability coverage/junit reports.
- Not covered here: "metrics token refused on API-001 (401)" belongs to the session guard (no API-001 route exists in this build).
