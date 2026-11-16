# RB-db: Database pressure

**Alert:** ALR-7 (`monitor`: `poolWait.p95WaitMs` over 250 ms; host alerts for connections or storage over 80%) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. Pool wait rising with a normal request rate means long transactions or a leak: look for long-running queries and idle-in-transaction sessions in PostgreSQL.
2. Connections and storage at the host's database page (VERIFY the host's own alerts exist; otherwise the daily platform review covers this).
3. A recent migration or a backup running at the same time.

## Actions

Ticket-level. Terminate stuck sessions only after noting them; scale the database plan only as an owner decision (cost). Never drop data to free space.

## Recovery

`poolWait.p95WaitMs` not over the threshold in one reading; host metrics below 70%.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
