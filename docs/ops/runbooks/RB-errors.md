# RB-errors: Elevated 5xx

**Alert:** ALR-2 (`monitor`: 5xx ratio over 2% with at least 100 requests in the 10-minute window of API-903) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. The Sentry issue tagged `rule: ALR-2` carries only the request and 5xx counts. Find the cause in the api error events (unexpected 5xx are reported, scrubbed) and logs filtered by `status` 5xx and route template.
2. Did a release go out in the last hour? Compare `release` on the events. If yes, treat as a failed release and roll back (`ROLLBACK-RUNBOOK.md`).
3. Check dependencies: database (RB-db), provider outage (shown as "provider unavailable", not a 5xx of ours), object store.

## Actions

Roll back, restart the single api instance, or fix forward. A restart resets the in-memory windows, so the alert shows insufficient data for a while: that is not recovery.

## Recovery

`monitor` reads recovery from one sample: the 15-minute window with at least 100 requests and a ratio below 1%. The Sentry issue is resolved when the next runs raise no event.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
