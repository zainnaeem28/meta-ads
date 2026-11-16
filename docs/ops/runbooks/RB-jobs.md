# RB-jobs: Job backlog

**Alert:** ALR-5 (`admin_alerts`: oldest queued paid job over 10 minutes while the worker is alive, or a job `submitting` beyond the orphan threshold) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. Worker alive? If not, this is RB-worker.
2. The admin alert lists job IDs (no personal data). Check the provider status and the 401/429 alerts (RB-security).
3. A job in `submitting` is never retried blindly: the provider call may have been made. Follow the orphan procedure of the job design (confirm with the provider by the stored idempotency reference before any retry).

## Actions

Let the sweep drain; if it persists for 1 hour the alert is page-worthy: stop new job creation by the spend cap or maintenance switch and inform the owner.

## Recovery

The queue drains and the admin alert resolves.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
