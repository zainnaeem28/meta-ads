# RB-backup: Backup stale

**Alert:** ALR-6 (backup heartbeat `HEARTBEAT_URL_BACKUP` expected every 24 hours with a 2-hour grace: newest successful backup older than 26 hours) (rules and thresholds: `infra/monitoring/alerts.json`). **Owner:** Operations owner. **Destination:** email to the owner and the administrators; no page-out is invented.

## First checks

1. Last run of the `backup` cron at the host and its log (a failed run sends no ping, by design).
2. The cause is usually credentials, storage, or the encryption recipient: see `docs/ops/backup.md` for the stages and their failure messages.

## Actions

Re-run the backup job by hand. If it still fails, treat RPO 24 h as at risk and tell the owner. Do not delete or shorten the retention of existing backups.

## Recovery

A successful run pings the heartbeat and closes the alert; verify the newest backup's age.

**Never** paste a token, DSN, heartbeat URL or signed URL into a ticket or a comment; name the secret key instead (`docs/ops/secrets.md`). After the fix, record what you saw, what you did and the time in the incident note named in `OPERATIONS-HANDOFF.md`.
