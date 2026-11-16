# RB-worker: Worker silent

**Alert:** ALR-4 (dead-man switch: `HEARTBEAT_URL_WORKER` missing for 15 minutes) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. The worker's service state and last logs at the host. The worker's metrics registry is not exposed, so health comes from the heartbeat, `admin_alerts` and Sentry only.
2. Is the database reachable (RB-db)? A worker that cannot reach PostgreSQL stops the sweep and so the heartbeat.
3. The `HEARTBEAT_URL_WORKER` key exists in the worker's secret store (name only; never print it).

## Actions

Restart the worker. Jobs are at-most-once: after a restart the sweep re-queues orphaned work; confirm with RB-jobs that nothing stays in `submitting`.

## Recovery

The next heartbeat closes the alert.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
