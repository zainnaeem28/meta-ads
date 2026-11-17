# Rollback runbook (skeleton)

Skeleton of `ROLLBACK-RUNBOOK.md` for the release package of one named environment (DEVOPS-PLAN §14.1 step 4, §14.5, §14.6). It holds everything that does not change between releases: the rules, the names, the decision matrix, the operator commands and the audit event each one writes. The release fills the per-release table ("Names this release fills") and attaches the result to its G3 package. Nothing here deploys anything: a deployment needs the environment's own G3 (`docs/ops/release.md`), and a staging G3 never authorizes production.

Owner: DevOps Engineer writes it; the Operations owner (the product owner until a person is named, DOP-OI-8) performs it. Names only: **no token, DSN, heartbeat URL, signed URL or key ever appears here or in a ticket**; name the secret instead (`docs/ops/secrets.md`).

## Rules that never change

1. **An artifact rollback does not undo a migration.** It does not reverse changes in the object store either. A container restart is not a rollback.
2. **Expand then contract** keeps the previous application compatible with the new schema for one release; that is the only reason an artifact rollback is safe. A forward fix is preferred for data.
3. **The prior artifact** is the newest entry of the release record (`deployments-<env>`, the previous three digests are retained). A rollback to a digest not named in a G3 needs a new decision unless this runbook names it as the approved prior artifact.
4. **The same locked job does it.** Traffic switches by the host's deploy of the recorded digest through `scripts/ci/release-with-recovery.sh` and its host adapter (`scripts/ci/hosts/render.sh rollback-api|rollback-worker|rollback-web DIGEST`), holding the `release-<env>` lock. The adapter refuses a digest that is not in the service's deploy history, so the record and the host must agree.
5. **Recovery order is newest layer first** (web, worker, api), to the previous digests only, and **never touches the database**. If recovery fails the job stays red, the owner is alerted and evidence is kept; never mark a deploy successful and never retry a destructive action.
6. **Application rollback is not proof the database was restored.** Say which of the two happened in the incident note.
7. **A compromised credential is revoked, never restored** (`docs/ops/secret-rotation.md`).
8. **Configuration rollback** reverts the host environment-variable change recorded in the release record, one service at a time.

## Names this release fills

| Name                                                       | Source                                                  | Value for this release    |
| ---------------------------------------------------------- | ------------------------------------------------------- | ------------------------- |
| Environment                                                | G3 record                                               | `staging` or `production` |
| Source SHA and `quality.json` sha256                       | `main` pipeline run                                     | per release               |
| Current digests (`api`, `worker`, `web`)                   | G3 record                                               | per release               |
| **Prior digests (`api`, `worker`, `web`)**                 | previous entry of `deployments-<env>`                   | per release               |
| Migrations in this release and whether each is expand-only | `apps/api/src/database/migrations`, `RELEASE-REVIEW.md` | per release               |
| Pre-migration backup id and time                           | `release-with-recovery.sh` step 2 (`backup`)            | per release               |
| Newest usable backup and the data-loss window              | `docs/ops/backup.md`                                    | per release (up to 24 h)  |
| Configuration changed                                      | release record                                          | per release               |
| Locks and access owners (names, not values)                | `DEPLOYMENT-PLAN.md`                                    | per release               |
| Incident owner and the person who may order a restore      | `OPERATIONS-HANDOFF.md`                                 | per release               |

## Decision matrix (DEVOPS-PLAN §14.4)

| Observation                                                                  | Decision                                                              | Recovery                                                                 | Check afterwards                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| Startup or readiness failure before traffic                                  | Keep the previous version, stop promotion                             | Config, image or runtime compatibility; no schema rollback assumed       | `/health/ready` 200 on the previous digests              |
| Error or latency over threshold after deploy (`scripts/ci/observe.sh` abort) | Halt, redeploy the **recorded previous digests** through the same job | Database and backfill compatibility, session behaviour                   | 3 passing probes, 5xx ratio and p95 back under threshold |
| Non-critical regression                                                      | Disable the reversible flag if one exists                             | Writes already made                                                      | The flag state in the release record                     |
| Clean transactional migration failure                                        | Halt, diagnose, correct                                               | Migration history and the old application's health                       | Ledger count, old application healthy                    |
| Partial or non-transactional migration                                       | Halt, inspect, approved repair or forward fix                         | Invalid indexes, partial backfill, locks                                 | Constraints valid, queues present                        |
| Data loss or corruption                                                      | Incident owner picks a restore into a **new** database                | Loss window, object-store consistency, erasure reconciliation, integrity | Restore drill checks (below)                             |
| Storage regression                                                           | Restore the object or the policy from the backup bucket               | Access isolation, URL expiry                                             | A signed read of a synthetic object                      |
| Recovery fails                                                               | Escalate, preserve evidence                                           | Nothing outside this runbook runs                                        | The job stays red                                        |

Abort thresholds that start a recovery during the observation window (`docs/ops/release.md`, proposed, calibrated in staging): `/health/ready` fails 3 probes in a row; 5xx ratio over 2% with at least 100 requests; p95 over twice the staging baseline with at least 200 requests; a job stuck in `submitting`; the KEK unseal alert; the worker heartbeat older than 15 minutes; the metrics cannot be read.

## Procedures

### A. Artifact rollback (failed deploy, smoke or observation)

1. Stop promotion; confirm the `release-<env>` lock is held by the failing run (`release-with-recovery.sh` recovers by itself on a failed deploy, smoke or observe step).
2. Read the prior digests from `deployments-<env>` (newest entry). No previous entry means recovery exits 2 and stays red: use procedure E.
3. Recover newest layer first: `scripts/ci/hosts/render.sh rollback-web <digest>`, `rollback-worker <digest>` (set the shutdown delay first; the old worker drains on SIGTERM and the sweep resumes its work), `rollback-api <digest>`; each waits for ready.
4. Verify: `/health/live` and `/health/ready` 200 on every service, the smoke journey, no job stuck in `submitting`, worker heartbeat fresh (RB-worker).
5. Record the result in `DEPLOYMENT-RESULT.md` and append the entry to `deployments-<env>`. A failed record step is reported, never hidden.

### B. Configuration rollback

Revert the host environment-variable change recorded in the release record for the affected service only, redeploy that service, verify as in A step 4. Startup validation names the key (exit 78, never a value).

### C. Migration failure

`db:migrate` or `jobs:migrate` failing halts the release with the old application still active: **no automatic retry and no automatic data rollback.** Inspect the schema and the `drizzle.__drizzle_migrations` ledger; decide forward fix or restore (procedure D). The migration rollback check of the restore drill (`docs/ops/restore-drill.md`, step 2) shows, per migration, the state before it is restorable from its pre-migration snapshot.

### D. Data restore (data loss or corruption)

Restore into a **new, isolated database**, never over live data. The incident owner decides; the loss window is the time since the newest usable backup (up to 24 h).

1. Take a pre-restore snapshot of the damaged state for evidence.
2. Decrypt the newest dump with the escrowed age identity (two custodians present, KC-3) and restore in sections (`pre-data`, `CREATE EXTENSION pg_trgm`, `data`, `post-data`); rebuild the drizzle ledger from the journal and grant `app_api` read access to it (restore-drill findings F-DR-1..F-DR-3).
3. Restore media from the `media/` mirror with SHA-256 checks against the manifest.
4. **Re-apply the erasure ledger** from `ledger/` before the restored system takes traffic: every subject erased since the backup is erased again (TC-LED-03, T-22). Never skip this.
5. Verify the KEK canary row opens with the held KEK (KC-6), row counts, constraints, roles and grants (`app_backup` cannot write).
6. Cut over by pointing the services at the new database through the locked job; keep the old database until the incident is closed.
7. Record the loss window, the objects restored, the reconciliation counts and who approved.

The exact steps and checks the agent baseline runs are `scripts/backup/restore-drill.sh --local`; the same drill in the real environment, with RTO (8 h) and RPO (24 h) sign-off, is go-live evidence (TC-H-08).

### E. Recovery impossible (no previous record, digest not in the host history, host unavailable)

Leave the job red, keep the evidence, alert the owner, and do not improvise. Open a decision through the Orchestrator naming the digest you intend to run; it needs a decision of the release owner under §14.6.

## Operator commands and their audit events

The one-off commands of the release image (ARCHITECTURE §7.3): `node dist/bin/ops.js <command> --env=<APP_ENV>` from `apps/api`. `--env` must equal the process's `APP_ENV`, otherwise the command exits 2 before any database connection. Each writes **one audit event with `actor_type = 'operator'` in the transaction of the change** and prints counts only (no key, ciphertext, email or identifier). Run under the process role shown.

| Command                  | Role (env files) | When                                                                                                                                           | Audit event (`action`, `object_type`)                                                                                                | Output counts                            | Exit 0 when                  |
| ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------- |
| `first-admin:reopen`     | api              | The owner email must be linked as first administrator again (lost or wrong first sign-in)                                                      | `first_admin.reopened`, `platform_settings`, outcome `allowed`                                                                       | `reopened`                               | done                         |
| `keys:disable-all`       | api              | Key-custody incident: every stored provider key is disabled (nothing is deleted); raises the admin alert `keys_disabled_all`                   | `key.disabled_all`, `provider_key`, outcome `allowed`                                                                                | `disabled`, `alerts_raised`              | done                         |
| `kek:rewrap`             | worker           | After a new KEK version is active in both maps: every data key is wrapped again, one row and one transaction at a time; a killed run continues | `kek.rewrapped`, `provider_key`, outcome `allowed` or `failed`                                                                       | `rewrapped`, `failed`, `already_current` | `failed` is 0 (otherwise 1)  |
| `erasure:resume <runId>` | worker           | A deletion run in state `stuck` goes back to `running`, attempts reset, and is queued again                                                    | `erasure.resumed`, `user` or `campaign` (object type of the run), outcome `allowed`; `failed` when the run is missing or not `stuck` | `resumed`, `not_found`, `not_stuck`      | `resumed` is 1 (otherwise 1) |

Exit codes: 0 done, 1 incomplete or failed (the audit event says `failed`), 2 refused (unknown command, missing or mismatching `--env`, a bad run id), 78 invalid process configuration (the log names the key). `kek:rewrap` needs `KEK_PRIVATE_KEYS` (worker only) and `erasure:resume` needs the `deletion_runs` update that only `app_worker` holds. The KEK procedure is `docs/ops/secret-rotation.md` ("KEK re-wrap"); the incident procedure is the security design's (AIU-17) and RB-security.

Local run of every command: `RUN-GUIDE.md` §8.

## Related release-job commands (no audit event of their own; their record is the release record)

| Command                                                | Purpose                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `scripts/ci/verify-release-approval.sh`                | Fails closed unless the G3 record matches this environment, digests, `quality.json` and plan |
| `scripts/ci/release-with-recovery.sh`                  | The locked job: backup, migrate, deploy api, worker, web, smoke, observe, record, recovery   |
| `scripts/ci/hosts/render.sh deploy-*` and `rollback-*` | The host adapter                                                                             |
| `scripts/ci/observe.sh`                                | The observation window and its abort thresholds                                              |
| `scripts/backup/restore-drill.sh --local`              | The restore drill baseline                                                                   |

## Evidence to keep after any rollback

What was seen and when (alert id, window), the digests before and after, the commands run and their outcome, whether the database was touched, the backup used if any, the audit events written, and who decided. In the incident note named in `OPERATIONS-HANDOFF.md`; never a secret.
