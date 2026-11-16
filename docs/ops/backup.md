# Backup service (`backup`)

The daily `backup` job (DO-07a, SB v6 §7.1, ARCHITECTURE §9.3, DEVOPS-PLAN §10.3). One run does three things as three separate identities: one `pg_dump` as `app_backup`, a byte copy of the `u/` media prefix and the erasure ledger read with the source token, and writes to the `backup` bucket with the sink token. It holds no KEK, no age private key and no application credential.

Code: `scripts/backup` (package `backup`, run with `node src/main.ts`). Image: the `backup` target of `docker/Dockerfile`. Local run: `docker/backup/compose.backup.yml`. Tests: `pnpm --filter backup test`.

## One run

| Step              | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Start          | Refuses (exit 78, naming the variable, never its value) when a forbidden variable is set or a required one is missing or malformed. Forbidden: every `KEK_V{n}`, `KEK_PRIVATE_KEYS`, an age private key (by name or by value), `DATABASE_URL`, `MIGRATION_DATABASE_URL`, R2 tokens A, B, C and any Admin token, signing and session secrets, deployment credentials and GitHub tokens (`src/forbidden.ts`; a test compares it to `backupForbidden` in `config/registry.json`)                                               |
| 1. Release window | Does not run while a release migration runs: waits up to `BACKUP_MIGRATION_WAIT_SECONDS` (default 3600), polling every `BACKUP_MIGRATION_POLL_SECONDS`, then exits 75 without a heartbeat. A migration is detected by the session advisory lock `release-migration` (`pg_advisory_lock(hashtextextended('release-migration', 0))`, taken by the `migrate` release step for its whole run) or by another session holding a Share, Share Row Exclusive, Exclusive or Access Exclusive lock on a table of `public` or `pgboss` |
| 2. Dump           | `pg_dump --format=custom --schema=public --schema=pgboss` (one connection, no `-j`, row security left off) piped into `age --recipient $BACKUP_AGE_RECIPIENT`; the plaintext never touches disk. Uploaded as `db/<yyyy-mm-dd>/<ulid>.dump.age` with `If-None-Match: *`. A dump error (a missing grant, a table with row security and no policy) fails the run and names the table                                                                                                                                           |
| 3. Media          | Lists `u/` only (never `q/` or `smoke/`), copies each new or changed object byte for byte to `media/<source key>/<source etag>` (size and MD5 checked from a spool file before the conditional put), and writes `manifests/<yyyy-mm-dd>.json` (key, etag, size, SHA-256, owner id, `deletedAt`, `movedTo`). A second manifest on the same day is `manifests/<date>-<runId>.json`                                                                                                                                            |
| 4. Delayed delete | A key missing from the source is marked `deletedAt` in the manifest. The run server-side copies its `media/` copy to `media-deleted/<date>/<key>/<etag>`, a HEAD confirms the same size and etag, and only then deletes the old `media/` copy. That is the only delete the service makes (the code refuses any other prefix). A failed confirmation keeps the old copy, fails the run and is retried next run                                                                                                               |
| 5. Ledger         | Copies every object of the `erasure-ledger` bucket to `ledger/<source key>`; write-once, no delayed delete, never a delete                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6. Result         | One JSON line `backup_run` on stdout (counts per step, bytes, `durationMs`, `failures`) and, when `BACKUP_RESULT_FILE` is set, the same as a file. The heartbeat `HEARTBEAT_URL_BACKUP` is pinged only when every step succeeded; a missed heartbeat raises ALR-6 at 26 h                                                                                                                                                                                                                                                   |

Exit codes: 0 complete, 1 a step failed (the other steps still ran), 75 a release migration kept the run from starting, 78 the environment was refused.

A failed dump does not stop the media copy, so media is protected before a source can vanish. The old `media/` copy of a deleted source is removed only when the bucket lock allows it (below); that is not a failure.

## Environment (names only)

| Name                                                                                                                                                                 | Class  | Note                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_LEDGER_BUCKET`, `R2_BACKUP_BUCKET`                                                                                        | public | three distinct bucket names                                                                                                            |
| `BACKUP_DATABASE_URL`                                                                                                                                                | secret | role `app_backup`; TLS outside development (`sslmode` in the URL)                                                                      |
| `R2_BACKUP_SOURCE_ACCESS_KEY_ID`, `R2_BACKUP_SOURCE_SECRET_ACCESS_KEY`                                                                                               | secret | Object Read only on `app` and `erasure-ledger`                                                                                         |
| `R2_BACKUP_SINK_ACCESS_KEY_ID`, `R2_BACKUP_SINK_SECRET_ACCESS_KEY`                                                                                                   | secret | Object Read & Write on `backup` only; not Admin                                                                                        |
| `BACKUP_AGE_RECIPIENT`                                                                                                                                               | public | `age1…` public recipient                                                                                                               |
| `HEARTBEAT_URL_BACKUP`                                                                                                                                               | secret | https URL                                                                                                                              |
| `BACKUP_RETENTION_DAYS`                                                                                                                                              | public | 7 to 365, default 30; equals the Admin-set lock age                                                                                    |
| `BACKUP_COPY_CONCURRENCY`, `BACKUP_MIGRATION_WAIT_SECONDS`, `BACKUP_MIGRATION_POLL_SECONDS`, `BACKUP_SPOOL_DIR`, `BACKUP_PG_DUMP_BIN`, `BACKUP_AGE_BIN`, `R2_REGION` | public | optional; defaults 4, 3600, 15, the temp folder, `pg_dump`, `age`, `auto`                                                              |
| `BACKUP_RESULT_FILE`, `BACKUP_ALLOW_SHARED_TOKEN`                                                                                                                    | public | file for the run result; `1` lets development and test use one credential for source and sink (the local MinIO has a single root user) |

`R2_BUCKET` is read by this service as well as by the api and worker; the registry lists it for those two only (change request, below).

Spool space: the dump and the largest media object are written to `BACKUP_SPOOL_DIR` (default `/tmp`, a tmpfs in the hardened container) before upload so a damaged read never becomes a content-addressed object. Size it for the larger of the two.

## Schedule

One Render cron job per environment, daily, proposed `17 2 * * *` (UTC), no inbound port; egress to the private PostgreSQL, the R2 endpoint and the heartbeat host. The cron entry belongs to `render.yaml` at DO-11.

## Bucket lock and lifecycle plan (applied by the owner; the service never sets it)

Set once per environment with the owner's Admin credential (SB-D23). The service holds no Admin token and cannot change either rule.

| Rule                   | Value                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Lock, prefix `ledger/` | indefinite retention                                                                                                  |
| Lock, whole bucket     | age `BACKUP_RETENTION_DAYS` (default 30)                                                                              |
| Lifecycle              | expire `db/`, `manifests/` and `media-deleted/` after `BACKUP_RETENTION_DAYS` + 1 days; none on `media/` or `ledger/` |
| Tokens                 | source: Object Read only on `app` and `erasure-ledger`; sink: Object Read & Write on `backup` only                    |

Verify the rules in the owner's test environment (TC-H-15) with the sink token: `APP_ENV=staging R2_ENDPOINT=… R2_BACKUP_BUCKET=… R2_BACKUP_SINK_ACCESS_KEY_ID=… R2_BACKUP_SINK_SECRET_ACCESS_KEY=… node scripts/backup/src/verify-locks.ts`. It writes one small probe object under `ledger/`, `db/` and `media/` (`_lockprobe/`), then tries a second conditional put, a plain overwrite and a delete on each. Exit 0 means every attempt was refused. Exit 3 prints `BLOCKING (DO-07)` lines: the host offers no usable lock and "no delete inside retention" is not met. That is a blocking finding for Cybersecurity through the Orchestrator and is never accepted silently. It refuses `APP_ENV=production` because probe objects stay under their lock until it expires.

Also to verify on the real account (VERIFY at DO-07): that R2 accepts `If-None-Match: *` on put, that prefix rules and indefinite retention exist, and that an in-bucket server-side copy counts as a new upload for the lock clock. Until then the emulator proves the script's behaviour only.

### Finding F-1 (non-blocking): the whole-bucket lock also covers `media/`

SB v6 §7.1 C applies the age lock to the whole bucket, so a `media/<key>/<etag>` copy cannot be deleted until it is older than `BACKUP_RETENTION_DAYS`. The final delete of the delayed delete therefore succeeds only for copies older than the retention. The service treats a refused delete as deferred: the `media-deleted/` copy is already confirmed (the data is safe in both places), the entry stays in the manifest as `movedTo` without `oldCopyRemoved`, and every later run retries until the lock lets it through. It is counted as `removalDeferred`, is not a failure and does not withhold the heartbeat. Effect: a deleted object occupies two copies for up to `BACKUP_RETENTION_DAYS` after its first copy (storage, not exposure). Recorded for the Solution Architect to confirm or to change the lock to exclude `media/`; it does not weaken any guarantee.

## Restore

Restore into a new, isolated target, never over live data (DEVOPS-PLAN §10.3). The operator, not the service, holds the age identity: `age --decrypt --identity <escrowed file> <dump>.dump.age | pg_restore --dbname <new database>`. Drop the target's empty `public` schema first (the archive creates it). Re-apply the erasure ledger from `ledger/` before the restored system takes traffic; that step is the restore runbook's (TC-LED-03), not this service's.

## Tests and what each proves

`pnpm --filter backup test` (needs `pg_dump` 17 on `PATH` or `PG_CLIENT_ROOT`, the shared test PostgreSQL, `age`, and a MinIO binary: `MINIO_BIN`, `PATH`, or the checksum-verified download of `tools/foundation-tests/media/tools.ts`; `age` is downloaded and checked the same way).

| File                    | Cases                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `tests/config.test.ts`  | TC-BKP-12 (every forbidden name, an age key by value, the real entry point exits 78 before any connection)     |
| `tests/scan.test.ts`    | TC-BKP-13 (image definition, compose and workflow definitions, the exact `pnpm deploy` payload), TC-BKP-09 (b) |
| `tests/buckets.test.ts` | TC-BKP-14, 15, 16, 25 and the lock verification (emulator of R2 token scopes and lock rules)                   |
| `tests/dump.test.ts`    | TC-BKP-01 (dump), 07, 09 (a, c), 10, 21, 23, 24 on the shared test PostgreSQL with the real M0001              |
| `tests/mirror.test.ts`  | TC-BKP-17 to 20, 22 (model), TC-LED-01, 02, 04, 05, 06                                                         |
| `tests/e2e.test.ts`     | the real entry point against a real MinIO and PostgreSQL, twice, with the delayed delete                       |

The role-level grant cases TC-BKP-01 to 11 as database tests are the TASK-025 suite (`apps/api/tests/integration/migrations`); this suite reuses its harness and applies the real M0001. TC-BKP-22's alert itself (ALR-6 at 26 h) is the monitoring provider's; the test shows that a failed run sends no ping and that the 26 h rule is measured from the last ping. TC-LED-03 (re-erasure on restore) belongs to the restore runbook.
