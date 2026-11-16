# RB-telemetry: Telemetry missing

**Alert:** ALR-9 (`monitor`: API-903 did not answer 200 with a valid body, or `telemetryDropped10m` above 0; or the `monitor` heartbeat stopped for 15 minutes) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. The event says only the rule and a read-failure code (1 unreachable, 2 timeout, 3 non-200 status, 4 invalid body) or the drop count.
2. Status 404 from API-903 means the token is missing at the api or wrong at `monitor`: compare the `METRICS_TOKEN` of both secret stores by rotating, never by printing (`docs/ops/secret-rotation.md`: set the api first, then `monitor`).
3. 5xx, timeout or unreachable: the api is down or slow (RB-startup, RB-latency). If the uptime probe is green, the private route from the `monitor` cron to the api is the suspect (VERIFY at staging).
4. `telemetryDropped10m` above 0: the error reporter or the heartbeat could not deliver in the last 10 minutes. Check the Sentry status and the vendor DSN; the cumulative `telemetryDroppedTotal` is not an alert input.
5. Heartbeat stopped: the `monitor` cron did not complete (host cron log).

## Recovery

A valid 200 with `telemetryDropped10m` at 0 on the next run. A restart of the api resets the window to 0; do not read that as the cause being fixed.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
