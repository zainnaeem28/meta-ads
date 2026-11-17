# Secret names and per-process secret sets

Generated from `config/registry.json` by `node scripts/ci/config-consistency.mjs --write`; edit the registry, not this file.
Names only: no value appears here or anywhere in the repository. Rotation procedures: `docs/ops/secret-rotation.md`.

## Where a name lives

Each secret is stored under the name `shroomap/<env>/<service>/<KEY>` in the host secret store of its environment (development, staging, production).
Deployment credentials are never repository secrets. `pull_request` runs receive none of these.

## Per-process secret sets

A process holds exactly its set. Startup refuses (exit 78, naming the key) any secret outside it.

| Service | Secrets it holds |
| --- | --- |
| `api` | `DATABASE_URL`, `CLERK_SECRET_KEY`, `KEY_FINGERPRINT_PEPPERS`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `RATE_LIMIT_IP_KEY`, `CURSOR_SIGNING_KEY`, `METRICS_TOKEN`, `SENTRY_DSN` |
| `worker` | `DATABASE_URL`, `CLERK_SECRET_KEY`, `KEK_PRIVATE_KEYS`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_LEDGER_ACCESS_KEY_ID`, `R2_LEDGER_SECRET_ACCESS_KEY`, `SHOTSTACK_API_KEY`, `HEARTBEAT_URL_WORKER`, `SENTRY_DSN` |
| `release` | `MIGRATION_DATABASE_URL` |
| `web` | `CLERK_SECRET_KEY` |
| `backup` | `BACKUP_DATABASE_URL`, `R2_BACKUP_SOURCE_ACCESS_KEY_ID`, `R2_BACKUP_SOURCE_SECRET_ACCESS_KEY`, `R2_BACKUP_SINK_ACCESS_KEY_ID`, `R2_BACKUP_SINK_SECRET_ACCESS_KEY`, `HEARTBEAT_URL_BACKUP` |
| `monitor` | `METRICS_TOKEN`, `SENTRY_DSN`, `HEARTBEAT_URL_MONITOR` |

## Secret-name map

| Key | Class | Held by | Store | Owner | Rotation |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | secret | api, worker | Host secret store, per service role (`app_api` for api, `app_worker` for worker) | Operations owner; DevOps provisions | Yearly or on compromise; two-step role password rotation with overlap |
| `MIGRATION_DATABASE_URL` | secret | release | Host secret store of the `migrate` release step only (`app_migrator`); never a CI variable on PR runs | Operations owner; DevOps provisions | Per environment after use if the owner wants; on compromise |
| `CLERK_SECRET_KEY` | secret | api, worker, web | Host secret store (api, worker, web) | Owner's Clerk account | On compromise or yearly; overlap then revoke |
| `KEK_PRIVATE_KEYS` | secret | worker | Host secret store of the worker only (highest sensitivity) | Operations owner (named minimum set, D-19) | By `kek:rewrap`: add version, switch active, re-wrap, remove old private key |
| `KEY_FINGERPRINT_PEPPERS` | secret | api | Host secret store (api) | Operations owner | Add a version; old fingerprints stay valid display values (TD-D6) |
| `R2_ACCESS_KEY_ID` | secret | api, worker | Host secret store; api holds token A, worker holds token B | Owner's Cloudflare account; Operations owner | Yearly or on compromise; overlap with the other token |
| `R2_SECRET_ACCESS_KEY` | secret | api, worker | Host secret store; api holds token A, worker holds token B | Owner's Cloudflare account; Operations owner | Yearly or on compromise; overlap with the other token |
| `R2_LEDGER_ACCESS_KEY_ID` | secret | worker | Host secret store of the worker only (token C, ledger bucket write-once and read) | Owner's Cloudflare account; Operations owner | Yearly or on compromise |
| `R2_LEDGER_SECRET_ACCESS_KEY` | secret | worker | Host secret store of the worker only (token C) | Owner's Cloudflare account; Operations owner | Yearly or on compromise |
| `RATE_LIMIT_IP_KEY` | secret | api | Host secret store (api) | Operations owner | On compromise; rotation resets IP buckets |
| `SHOTSTACK_API_KEY` | secret | worker | Host secret store (worker), only with the Shotstack adapter | Owner's vendor account | On compromise or yearly |
| `CURSOR_SIGNING_KEY` | secret | api | Host secret store (api) | Operations owner | On compromise or yearly; open cursors restart at page 1 |
| `HEARTBEAT_URL_WORKER` | secret | worker | Host secret store (worker) | DevOps | On compromise |
| `METRICS_TOKEN` | secret | api, monitor | Host secret store of api and `monitor`; release executor secret store for the observation step | DevOps | Yearly or on compromise; overlap api first |
| `SENTRY_DSN` | secret | api, worker, monitor | Host secret store (api, worker, monitor) | DevOps | On compromise |
| `BACKUP_DATABASE_URL` | secret | backup | Host secret store of the `backup` service only | DevOps creates the role (DO-11); Operations owner holds the password | Yearly or on compromise; two-step role password rotation with overlap |
| `R2_BACKUP_SOURCE_ACCESS_KEY_ID` | secret | backup | Host secret store of the `backup` service only | Owner's Cloudflare account; Operations owner | Yearly or on compromise; overlap |
| `R2_BACKUP_SOURCE_SECRET_ACCESS_KEY` | secret | backup | Host secret store of the `backup` service only | Owner's Cloudflare account; Operations owner | Yearly or on compromise; overlap |
| `R2_BACKUP_SINK_ACCESS_KEY_ID` | secret | backup | Host secret store of the `backup` service only | Owner's Cloudflare account; Operations owner | Yearly or on compromise; overlap |
| `R2_BACKUP_SINK_SECRET_ACCESS_KEY` | secret | backup | Host secret store of the `backup` service only | Owner's Cloudflare account; Operations owner | Yearly or on compromise; overlap |
| `HEARTBEAT_URL_BACKUP` | secret | backup | Host secret store of the `backup` service only | DevOps | On compromise |
| `HEARTBEAT_URL_MONITOR` | secret | monitor | Host secret store of the `monitor` cron | DevOps | On compromise |

### Name per environment

| Key | `development` | `staging` | `production` |
| --- | --- | --- | --- |
| `DATABASE_URL` | `shroomap/development/api/DATABASE_URL` | `shroomap/staging/api/DATABASE_URL` | `shroomap/production/api/DATABASE_URL` |
| `MIGRATION_DATABASE_URL` | `shroomap/development/release/MIGRATION_DATABASE_URL` | `shroomap/staging/release/MIGRATION_DATABASE_URL` | `shroomap/production/release/MIGRATION_DATABASE_URL` |
| `CLERK_SECRET_KEY` | `shroomap/development/api/CLERK_SECRET_KEY` | `shroomap/staging/api/CLERK_SECRET_KEY` | `shroomap/production/api/CLERK_SECRET_KEY` |
| `KEK_PRIVATE_KEYS` | `shroomap/development/worker/KEK_PRIVATE_KEYS` | `shroomap/staging/worker/KEK_PRIVATE_KEYS` | `shroomap/production/worker/KEK_PRIVATE_KEYS` |
| `KEY_FINGERPRINT_PEPPERS` | `shroomap/development/api/KEY_FINGERPRINT_PEPPERS` | `shroomap/staging/api/KEY_FINGERPRINT_PEPPERS` | `shroomap/production/api/KEY_FINGERPRINT_PEPPERS` |
| `R2_ACCESS_KEY_ID` | `shroomap/development/api/R2_ACCESS_KEY_ID` | `shroomap/staging/api/R2_ACCESS_KEY_ID` | `shroomap/production/api/R2_ACCESS_KEY_ID` |
| `R2_SECRET_ACCESS_KEY` | `shroomap/development/api/R2_SECRET_ACCESS_KEY` | `shroomap/staging/api/R2_SECRET_ACCESS_KEY` | `shroomap/production/api/R2_SECRET_ACCESS_KEY` |
| `R2_LEDGER_ACCESS_KEY_ID` | `shroomap/development/worker/R2_LEDGER_ACCESS_KEY_ID` | `shroomap/staging/worker/R2_LEDGER_ACCESS_KEY_ID` | `shroomap/production/worker/R2_LEDGER_ACCESS_KEY_ID` |
| `R2_LEDGER_SECRET_ACCESS_KEY` | `shroomap/development/worker/R2_LEDGER_SECRET_ACCESS_KEY` | `shroomap/staging/worker/R2_LEDGER_SECRET_ACCESS_KEY` | `shroomap/production/worker/R2_LEDGER_SECRET_ACCESS_KEY` |
| `RATE_LIMIT_IP_KEY` | `shroomap/development/api/RATE_LIMIT_IP_KEY` | `shroomap/staging/api/RATE_LIMIT_IP_KEY` | `shroomap/production/api/RATE_LIMIT_IP_KEY` |
| `SHOTSTACK_API_KEY` | `shroomap/development/worker/SHOTSTACK_API_KEY` | `shroomap/staging/worker/SHOTSTACK_API_KEY` | `shroomap/production/worker/SHOTSTACK_API_KEY` |
| `CURSOR_SIGNING_KEY` | `shroomap/development/api/CURSOR_SIGNING_KEY` | `shroomap/staging/api/CURSOR_SIGNING_KEY` | `shroomap/production/api/CURSOR_SIGNING_KEY` |
| `HEARTBEAT_URL_WORKER` | `shroomap/development/worker/HEARTBEAT_URL_WORKER` | `shroomap/staging/worker/HEARTBEAT_URL_WORKER` | `shroomap/production/worker/HEARTBEAT_URL_WORKER` |
| `METRICS_TOKEN` | `shroomap/development/api/METRICS_TOKEN` | `shroomap/staging/api/METRICS_TOKEN` | `shroomap/production/api/METRICS_TOKEN` |
| `SENTRY_DSN` | `shroomap/development/api/SENTRY_DSN` | `shroomap/staging/api/SENTRY_DSN` | `shroomap/production/api/SENTRY_DSN` |
| `BACKUP_DATABASE_URL` | `shroomap/development/backup/BACKUP_DATABASE_URL` | `shroomap/staging/backup/BACKUP_DATABASE_URL` | `shroomap/production/backup/BACKUP_DATABASE_URL` |
| `R2_BACKUP_SOURCE_ACCESS_KEY_ID` | `shroomap/development/backup/R2_BACKUP_SOURCE_ACCESS_KEY_ID` | `shroomap/staging/backup/R2_BACKUP_SOURCE_ACCESS_KEY_ID` | `shroomap/production/backup/R2_BACKUP_SOURCE_ACCESS_KEY_ID` |
| `R2_BACKUP_SOURCE_SECRET_ACCESS_KEY` | `shroomap/development/backup/R2_BACKUP_SOURCE_SECRET_ACCESS_KEY` | `shroomap/staging/backup/R2_BACKUP_SOURCE_SECRET_ACCESS_KEY` | `shroomap/production/backup/R2_BACKUP_SOURCE_SECRET_ACCESS_KEY` |
| `R2_BACKUP_SINK_ACCESS_KEY_ID` | `shroomap/development/backup/R2_BACKUP_SINK_ACCESS_KEY_ID` | `shroomap/staging/backup/R2_BACKUP_SINK_ACCESS_KEY_ID` | `shroomap/production/backup/R2_BACKUP_SINK_ACCESS_KEY_ID` |
| `R2_BACKUP_SINK_SECRET_ACCESS_KEY` | `shroomap/development/backup/R2_BACKUP_SINK_SECRET_ACCESS_KEY` | `shroomap/staging/backup/R2_BACKUP_SINK_SECRET_ACCESS_KEY` | `shroomap/production/backup/R2_BACKUP_SINK_SECRET_ACCESS_KEY` |
| `HEARTBEAT_URL_BACKUP` | `shroomap/development/backup/HEARTBEAT_URL_BACKUP` | `shroomap/staging/backup/HEARTBEAT_URL_BACKUP` | `shroomap/production/backup/HEARTBEAT_URL_BACKUP` |
| `HEARTBEAT_URL_MONITOR` | `shroomap/development/monitor/HEARTBEAT_URL_MONITOR` | `shroomap/staging/monitor/HEARTBEAT_URL_MONITOR` | `shroomap/production/monitor/HEARTBEAT_URL_MONITOR` |

## Forbidden variables per service

The container checks fail when an image or service definition sets one of these for the service.

- **api** must not hold: `MIGRATION_DATABASE_URL`, `KEK_PRIVATE_KEYS`, `R2_LEDGER_ACCESS_KEY_ID`, `R2_LEDGER_SECRET_ACCESS_KEY`, `SHOTSTACK_API_KEY`, `HEARTBEAT_URL_WORKER`, `BACKUP_DATABASE_URL`, `R2_BACKUP_SOURCE_ACCESS_KEY_ID`, `R2_BACKUP_SOURCE_SECRET_ACCESS_KEY`, `R2_BACKUP_SINK_ACCESS_KEY_ID`, `R2_BACKUP_SINK_SECRET_ACCESS_KEY`, `HEARTBEAT_URL_BACKUP`, `HEARTBEAT_URL_MONITOR`, `KEK_V*`, `HMAC_PEPPER`, `RENDER_API_KEY`, `GHCR_PULL_TOKEN`, `SENTRY_AUTH_TOKEN`, `GITHUB_TOKEN`, `PAPERCLIP_G3_READER_TOKEN`, `AGE_SECRET_KEY`, `AGE_PRIVATE_KEY`, `BACKUP_AGE_IDENTITY`.
- **worker** must not hold: `MIGRATION_DATABASE_URL`, `KEY_FINGERPRINT_PEPPERS`, `RATE_LIMIT_IP_KEY`, `CURSOR_SIGNING_KEY`, `METRICS_TOKEN`, `BACKUP_DATABASE_URL`, `R2_BACKUP_SOURCE_ACCESS_KEY_ID`, `R2_BACKUP_SOURCE_SECRET_ACCESS_KEY`, `R2_BACKUP_SINK_ACCESS_KEY_ID`, `R2_BACKUP_SINK_SECRET_ACCESS_KEY`, `HEARTBEAT_URL_BACKUP`, `HEARTBEAT_URL_MONITOR`, `KEK_V*`, `HMAC_PEPPER`, `RENDER_API_KEY`, `GHCR_PULL_TOKEN`, `SENTRY_AUTH_TOKEN`, `GITHUB_TOKEN`, `PAPERCLIP_G3_READER_TOKEN`, `AGE_SECRET_KEY`, `AGE_PRIVATE_KEY`, `BACKUP_AGE_IDENTITY`.
- **web** must not hold: `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `KEK_PRIVATE_KEYS`, `KEY_FINGERPRINT_PEPPERS`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_LEDGER_ACCESS_KEY_ID`, `R2_LEDGER_SECRET_ACCESS_KEY`, `RATE_LIMIT_IP_KEY`, `SHOTSTACK_API_KEY`, `CURSOR_SIGNING_KEY`, `HEARTBEAT_URL_WORKER`, `METRICS_TOKEN`, `SENTRY_DSN`, `BACKUP_DATABASE_URL`, `R2_BACKUP_SOURCE_ACCESS_KEY_ID`, `R2_BACKUP_SOURCE_SECRET_ACCESS_KEY`, `R2_BACKUP_SINK_ACCESS_KEY_ID`, `R2_BACKUP_SINK_SECRET_ACCESS_KEY`, `HEARTBEAT_URL_BACKUP`, `HEARTBEAT_URL_MONITOR`, `KEK_V*`, `HMAC_PEPPER`, `RENDER_API_KEY`, `GHCR_PULL_TOKEN`, `SENTRY_AUTH_TOKEN`, `GITHUB_TOKEN`, `PAPERCLIP_G3_READER_TOKEN`, `AGE_SECRET_KEY`, `AGE_PRIVATE_KEY`, `BACKUP_AGE_IDENTITY`.
- **backup** must not hold: `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `CLERK_SECRET_KEY`, `KEK_PRIVATE_KEYS`, `KEY_FINGERPRINT_PEPPERS`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_LEDGER_ACCESS_KEY_ID`, `R2_LEDGER_SECRET_ACCESS_KEY`, `RATE_LIMIT_IP_KEY`, `SHOTSTACK_API_KEY`, `CURSOR_SIGNING_KEY`, `HEARTBEAT_URL_WORKER`, `METRICS_TOKEN`, `SENTRY_DSN`, `HEARTBEAT_URL_MONITOR`, `KEK_V*`, `HMAC_PEPPER`, `RENDER_API_KEY`, `GHCR_PULL_TOKEN`, `SENTRY_AUTH_TOKEN`, `GITHUB_TOKEN`, `PAPERCLIP_G3_READER_TOKEN`, `AGE_SECRET_KEY`, `AGE_PRIVATE_KEY`, `BACKUP_AGE_IDENTITY`.

The `backup` image never holds the KEK (any `KEK_*`) or the age private key (`AGE_SECRET_KEY`, `AGE_PRIVATE_KEY`, `BACKUP_AGE_IDENTITY`); it holds the public recipient only.

## Variables that are not secrets

| Key | Read by | Required in | Default |
| --- | --- | --- | --- |
| `APP_ENV` | api, worker, release, web, backup, monitor | api, worker, release, web, backup, monitor | none |
| `RELEASE_SHA` | api, worker, release | none | none |
| `API_PORT` | api | none | `4000` |
| `WEB_ORIGIN` | api, web | api, web | none |
| `TRUST_PROXY_HOPS` | api | none | `1` |
| `LOG_LEVEL` | api, worker, release, web, backup, monitor | none | `info` |
| `DATABASE_POOL_MAX` | api, worker | none | `10` |
| `DATABASE_ACQUIRE_TIMEOUT_MS` | api, worker | none | `5000` |
| `CLERK_JWT_ISSUER` | api | api | none |
| `OWNER_EMAIL` | api | none | none |
| `MFA_REQUIRED_FOR` | api | none | `all` |
| `RECENT_AUTH_MAX_AGE_MIN` | api | none | `10` |
| `INVITE_EMAIL_DOMAINS` | api | none | `` |
| `INVITE_EXPIRY_DAYS` | api | none | `7` |
| `ACCESS_REQUEST_FORM_ENABLED` | api | none | `false` |
| `SIGNUP_OPEN_EMAIL_VERIFICATION` | api | none | `false` |
| `SIGNUP_OPEN_RATE_LIMIT` | api | none | `false` |
| `SIGNUP_OPEN_ABUSE_LIMITS` | api | none | `false` |
| `KEK_PUBLIC_KEYS` | api, worker | api, worker | none |
| `KEK_ACTIVE_VERSION` | api, worker | api, worker | none |
| `KEY_FINGERPRINT_PEPPER_ACTIVE` | api | api | none |
| `KEY_ENTRY_ATTEMPTS_PER_WINDOW` | api | none | `5` |
| `KEY_ENTRY_WINDOW_MIN` | api | none | `10` |
| `KEY_AUTO_DISABLE_THRESHOLD` | worker | none | `5` |
| `KEY_FORMAT_OPENAI` | api | none | `^sk-[A-Za-z0-9_-]{20,}$` |
| `KEY_FORMAT_WAVESPEED` | api | none | `^[A-Za-z0-9_-]{20,}$` |
| `PROBE_TIMEOUT_MS` | api | none | `5000` |
| `R2_ENDPOINT` | api, worker, backup | api, worker, backup | none |
| `R2_BUCKET` | api, worker | api, worker | none |
| `R2_LEDGER_BUCKET` | worker, backup | worker, backup | none |
| `STORAGE_PUBLIC_ORIGIN` | api | none | none |
| `MEDIA_MAX_UPLOAD_BYTES` | api | none | `10485760` |
| `MEDIA_MAX_PIXEL_DIMENSION` | worker | none | `8000` |
| `MEDIA_MAX_PIXELS` | worker | none | `40000000` |
| `MEDIA_BROWSER_URL_TTL_SEC` | api | none | `300` |
| `PROVIDER_FETCH_URL_TTL_SEC` | worker | none | `3600` |
| `MEDIA_UNATTACHED_TTL_HOURS` | worker | none | `24` |
| `STORAGE_QUOTA_BYTES` | api | none | `21474836480` |
| `SPEND_CAP_DAILY_USD` | api | none | `50` |
| `SPEND_CAP_MONTHLY_USD` | api | none | `500` |
| `JOB_BURST_ALERT_COUNT` | api | none | `20` |
| `JOB_BURST_WINDOW_MIN` | api | none | `10` |
| `PROVIDER_AUTH_SPIKE_COUNT` | worker | none | `5` |
| `PROVIDER_AUTH_SPIKE_WINDOW_MIN` | worker | none | `10` |
| `JOB_CREATE_RATE_LIMIT` | api | none | `60` |
| `JOB_CREATE_RATE_WINDOW_MIN` | api | none | `10` |
| `RUNNING_JOBS_PER_USER` | worker | none | `5` |
| `ASSEMBLY_RENDERS_PER_USER_PER_DAY` | api | none | `20` |
| `ASSEMBLY_ADAPTER` | worker | none | `ffmpeg` |
| `ASSEMBLY_VENDOR_PLATFORM_CAP` | worker | none | none |
| `ASSEMBLY_CONCURRENCY` | worker | none | `1` |
| `THUMBSTOPPER_FRAME_SECONDS` | worker | none | `1.5` |
| `PROVIDER_HTTP_TIMEOUT_MS` | worker | none | `120000` |
| `SUBMIT_JOB_EXPIRE_SEC` | worker | none | `150` |
| `SUBMIT_ORPHAN_AFTER_SEC` | worker | none | `300` |
| `POLL_INTERVAL_SEC` | worker | none | `5` |
| `POLL_LEASE_SEC` | worker | none | `60` |
| `VIDEO_JOB_DEADLINE_MIN` | worker | none | `30` |
| `PROVIDER_OUTPUT_COPY_WINDOW_HOURS` | worker | none | `24` |
| `INVITATION_SEND_STALE_MIN` | worker | none | `15` |
| `PROVIDER_OUTPUT_MAX_BYTES` | worker | none | `209715200` |
| `EGRESS_ALLOWED_HOSTS` | api, worker | none | `{"openai":["api.openai.com"],"wavespeed":["api.wavespeed.ai"]}` |
| `WORKER_PROVIDER_ORIGIN_OVERRIDE` | worker | none | none |
| `WAVESPEED_MODEL_I2V` | worker | none | `bytedance/seedance-2.0/image-to-video` |
| `WAVESPEED_MODEL_T2V` | worker | none | `bytedance/seedance-2.0/text-to-video` |
| `VIDEO_RESOLUTION` | worker | none | `1080p` |
| `VIDEO_ASPECT_RATIO` | worker | none | `9:16` |
| `VIDEO_SEGMENT_SECONDS` | worker | none | `15` |
| `OPENAI_TEXT_MODEL` | worker | none | none |
| `OPENAI_VISION_MODEL` | worker | none | none |
| `OPENAI_TRANSCRIBE_MODEL` | worker | none | `gpt-transcribe` |
| `OPENAI_IMAGE_MODEL` | worker | none | none |
| `QC_MAX_WORD_ERROR_RATE` | worker | none | `0.20` |
| `IDEMPOTENCY_TTL_HOURS` | api | none | `24` |
| `REPORT_DEFAULT_WINDOW_DAYS` | api | none | `30` |
| `REPORT_MAX_WINDOW_DAYS` | api | none | `366` |
| `ERASURE_HOLD_PERIOD_HOURS` | api | none | `0` |
| `DELETION_RETRY_LIMIT` | worker | none | `10` |
| `WORKER_WATCHDOG_SECONDS` | worker | none | `180` |
| `WORKER_DRAIN_SECONDS` | worker | none | `25` |
| `API_DRAIN_SECONDS` | api | none | `20` |
| `WORKER_CONCURRENCY_PROVIDER` | worker | none | `20` |
| `WORKER_CONCURRENCY_SANITIZE` | worker | none | `2` |
| `WORKER_CONCURRENCY_DELETION` | worker | none | `2` |
| `SENTRY_ENVIRONMENT` | api, worker, web, monitor | none | none |
| `SENTRY_ERRORS_SAMPLE_RATE` | api, worker, web | none | `1.0` |
| `SENTRY_TRACES_SAMPLE_RATE` | api, worker, web | none | `0` |
| `PROVIDER_DATA_MODE_OPENAI` | worker | none | `synthetic` |
| `PROVIDER_DATA_MODE_WAVESPEED` | worker | none | `synthetic` |
| `PROVIDER_DATA_MODE_SHOTSTACK` | worker | none | `synthetic` |
| `BACKUP_AGE_RECIPIENT` | backup | backup | none |
| `R2_BACKUP_BUCKET` | backup | backup | none |
| `BACKUP_RETENTION_DAYS` | backup | none | `30` |
| `NEXT_PUBLIC_API_ORIGIN` | web | web | none |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | web | web | none |
| `NEXT_PUBLIC_SENTRY_DSN` | web | none | none |
| `IDENTITY_MODE` | api | none | none |
| `AUTH_MODE` | web | none | none |
