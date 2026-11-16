# RB-security: Security or spend events

**Alert:** ALR-8 (`admin_alerts` raised by the worker: provider 401/429 burst, spend cap, KEK unseal failure, stuck deletion) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. Read the admin alert in the administrator screen. It holds IDs and counts, no key material and no email address.
2. KEK unseal failure is page-worthy: stop releases, do not rotate keys in a hurry, and follow the KEK custody procedure (`docs/ops/secret-rotation.md`, DEVOPS-PLAN 10.4).
3. Provider 401: a revoked or wrong key (the owner re-enters it); 429: a rate limit or spend cap.

## Actions

Decisions about keys, spend and users belong to the owner. This runbook is the operations stub; the security design's incident procedure (AIU-17) is authoritative where it differs.

## Recovery

The admin alert is resolved in the product.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
