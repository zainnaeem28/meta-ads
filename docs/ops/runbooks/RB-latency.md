# RB-latency: Latency

**Alert:** ALR-3 (`monitor`: p95 over 500 ms with at least 200 requests in the 15-minute window) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. Pool wait (ALR-7) and database load: RB-db. Slow queries and a saturated pool are the usual cause.
2. A burst from one account (rate-limit counters in the logs), provider calls on the request path, and the host's CPU and memory metrics.
3. Compare with the baseline of the last release (`OBSERVE_BASELINE_P95_MS` in the release record).

## Actions

Ticket-level: investigate within the working day. Roll back if tied to a release.

## Recovery

One reading with at least 200 requests and p95 not over 500 ms is recovery for `monitor`; the issue auto-resolves after 30 minutes without a new event (a Sentry issue-alert setting, `infra/monitoring/sentry.json`).

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
