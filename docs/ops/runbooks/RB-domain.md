# RB-domain: Certificate or domain expiry

**Alert:** ALR-10 (uptime vendor's SSL check, 21 days to expiry) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. Which name: the api origin, the web origin or the domain registration. The host renews managed certificates automatically; a custom domain needs its DNS record intact.
2. Domain registration expiry and the registrar contact are owner items.

## Actions

Renew at the registrar or restore the DNS record; re-verify the certificate at the host.

## Recovery

The next daily check shows more than 21 days.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
