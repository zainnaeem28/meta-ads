# RB-startup: App down

**Alert:** ALR-1 (uptime vendor, `GET /health/ready` fails from 2 locations, 3 probes) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. `GET /health/live` of the api: 200 means the process runs and the fault is readiness. No answer means the service is down or the host is.
2. `GET /health/ready` answers 503 with no detail by design. Read the api's startup and error logs (`service`, `release`, `requestId` fields) and the host's deploy events: a failed deploy, a restart loop or a SIGTERM drain.
3. Readiness is 200 only when PostgreSQL answers, pg-boss is installed, the applied migration count is within `MIN_SCHEMA_HEAD`..`MAX_SCHEMA_HEAD`, and the configuration is valid. A schema head outside the range after a release means the wrong artifact is running.

## Actions

- Bad deploy: roll back by artifact digest as in `ROLLBACK-RUNBOOK.md` (application rollback is not proof the database was restored).
- Database unreachable: follow RB-db.
- Configuration invalid: the startup log names the key (never a value); fix it in the host secret store and restart.

## Recovery

3 consecutive passing probes close the alert. Check ALR-9 did not fire from the same outage.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
