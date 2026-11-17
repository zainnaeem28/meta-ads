# Operations handoff (skeleton)

Skeleton of `OPERATIONS-HANDOFF.md` for the release package of one named environment (DEVOPS-PLAN §14.1 step 4, NFR-12). It carries what is true of every release; the release fills the "Names this release fills" table and the owner confirms it at OPERATIONS_RECEIPT. Names only: no secret value, DSN, token, heartbeat URL or signed URL appears here.

## Ownership

| Role                                                                                                      | Who                                                                                                             | Source                           |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Operations owner (alert owner for ALR-1..ALR-10, performs rollbacks and rotations, calibrates thresholds) | The product owner account until a person is named (DOP-OI-8, OD-16); a name is due **before the production G3** | `docs/ops/owner-items.md`        |
| Release owner (decides recovery that this runbook does not name)                                          | Same                                                                                                            | `docs/ops/ROLLBACK-RUNBOOK.md`   |
| Incident owner (orders a restore)                                                                         | Operations owner                                                                                                | `docs/ops/ROLLBACK-RUNBOOK.md` D |
| Support coverage and hours                                                                                | Unspecified at G1 (OD-16); the owner states them                                                                | `docs/ops/owner-items.md`        |
| KEK offline-copy holder and age-identity custodians (two, KC-3)                                           | Named by the owner (G-2)                                                                                        | `docs/ops/secret-rotation.md`    |

Alerts go by email to the owner and the administrators. No page-out exists; none is invented. No response time is promised until the owner states support hours.

## What runs

| Service    | Image target           | Role                                                                                                        | Held secrets                                                                                         |
| ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `api`      | `api`                  | HTTP api, identity, media, campaigns, usage, metrics window                                                 | Database role `app_api`, storage token A, KEK **public** map, pepper map, cursor and rate-limit keys |
| `worker`   | `worker` (with FFmpeg) | pg-boss jobs: provider calls, sanitising, assembly, deletion, sweep; the only holder of the KEK private map | Database role `app_worker`, storage tokens B and C (ledger)                                          |
| `web`      | `web`                  | Next.js application                                                                                         | Identity publishable key                                                                             |
| `migrate`  | the api image          | Release one-off: `db:migrate`, `jobs:migrate`, `db:seed --dataset=reference` as `app_migrator`              | `MIGRATION_DATABASE_URL` only                                                                        |
| `backup`   | `backup`               | Daily dump (encrypted to the age recipient), media and ledger mirror                                        | `app_backup`, backup source and sink tokens; no KEK, no age private key                              |
| `monitor`  | see `scripts/monitor`  | Reads `API-903` and sends the dead-man heartbeat                                                            | Metrics token                                                                                        |
| PostgreSQL | managed                | Data and pg-boss schema                                                                                     | host                                                                                                 |

The secret sets per process and who rotates what: `docs/ops/secrets.md`, `docs/ops/secret-rotation.md`.

## Alerts and their runbooks

Rules and thresholds: `infra/monitoring/alerts.json`. Every runbook lists first checks, actions and recovery; ALR-9 backs up ALR-2 to ALR-5 and ALR-7 when the data itself is missing.

| Alert  | Meaning                                                                                          | Runbook                             |
| ------ | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| ALR-1  | App down: `/health/ready` fails from 2 locations, 3 probes                                       | `docs/ops/runbooks/RB-startup.md`   |
| ALR-2  | 5xx ratio over 2% in 10 minutes                                                                  | `docs/ops/runbooks/RB-errors.md`    |
| ALR-3  | p95 over 500 ms in 15 minutes                                                                    | `docs/ops/runbooks/RB-latency.md`   |
| ALR-4  | Worker silent: heartbeat missing 15 minutes                                                      | `docs/ops/runbooks/RB-worker.md`    |
| ALR-5  | Job backlog or a job stuck in `submitting`                                                       | `docs/ops/runbooks/RB-jobs.md`      |
| ALR-6  | Backup stale: nothing successful in 26 hours                                                     | `docs/ops/runbooks/RB-backup.md`    |
| ALR-7  | Database pressure: pool wait over 250 ms, connections or storage over 80%                        | `docs/ops/runbooks/RB-db.md`        |
| ALR-8  | Security or spend events (provider 401/429 burst, spend cap, KEK unseal failure, stuck deletion) | `docs/ops/runbooks/RB-security.md`  |
| ALR-9  | Telemetry missing: the metrics window does not answer 200 with a valid body                      | `docs/ops/runbooks/RB-telemetry.md` |
| ALR-10 | Certificate or domain expiry in 21 days                                                          | `docs/ops/runbooks/RB-domain.md`    |

Roll back with `docs/ops/ROLLBACK-RUNBOOK.md`. The four operator commands and their audit events are in its table.

## Routine

| When                                                                                             | What                                                                                                                                                             | Where                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| After each release                                                                               | Observation window (60 minutes production, 30 staging), then the **next-business-day check** of failed and stuck jobs and the append of the release record entry | `docs/ops/release.md`         |
| Daily (backup runs daily)                                                                        | Newest backup is under 26 hours old (heartbeat, ALR-6); the host's own database and storage alerts exist and are read (DEVOPS-PLAN VERIFY item)                  | `docs/ops/backup.md`          |
| Per rotation cadence                                                                             | Rotate the keys of the per-key table; record who, when, which key names, outcomes                                                                                | `docs/ops/secret-rotation.md` |
| Per milestone                                                                                    | Rescan (dependency, SAST, secrets, container, IaC)                                                                                                               | `docs/ops/rescan.md`          |
| Before go-live, then on the owner's schedule and after any change of custodians or backup design | Restore drill in the real environment; RTO 8 h and RPO 24 h against measured values                                                                              | `docs/ops/restore-drill.md`   |
| On a custodian change                                                                            | KEK custody check (KC-6 canary)                                                                                                                                  | `docs/ops/secret-rotation.md` |

## Names this release fills

| Name                                                                                           | Value for this release          |
| ---------------------------------------------------------------------------------------------- | ------------------------------- |
| Environment and public origins                                                                 | per release                     |
| Hosting account and workspace owner                                                            | owner                           |
| Digests (`api`, `worker`, `web`) and release record entry                                      | per release                     |
| Alert destination addresses                                                                    | owner                           |
| Uptime monitor and error tracker accounts (names, not keys)                                    | owner                           |
| Operations owner (a person) and support hours                                                  | owner, before the production G3 |
| Backup retention (`BACKUP_RETENTION_DAYS`, default 30) and the lock rule applied on the bucket | owner                           |
| Last restore drill in the real environment: date, loss window, restore time                    | per drill                       |

## Incident note

Record, for every incident or rollback and without any secret: alert id and time, what was seen, what was done and the time, whether the database was touched, digests before and after, the audit events written, the decision owner, and the follow-up. Keep it in the incident task of the release.

## Documentation readiness (ARCHITECTURE §9.4)

When implementation lands, these artifacts are updated by their owners: `ARCHITECTURE.md` (Solution Architect), `openapi.yaml` (contract tickets), schema and migrations (database tickets), `.env.example` (each runtime owner; generated from `config/registry.json`), `RUN-GUIDE.md`, `README.md`, the migration and seed steps and this runbook set (DevOps), the price table and the brand rules files (Solution Architect, reviewed pull requests). `scripts/ci/docs-check.sh` fails when a named script, file, operator command or audit event no longer exists, when `.env.example` has a variable the README table omits, and when the owner-item list differs from the register.

## Go-live evidence and product gaps (two lists, never mixed)

Go-live evidence (never blocks acceptance, never stands in for a feature): `docs/ops/owner-items.md`, plus full-scale load test in the target environment; restore drill and RTO/RPO sign-off in the real environment; independent penetration test; real assistive-technology checks; vendor contracts recorded in the compliance register before any adapter runs on real data (Render, Clerk, R2, Sentry, uptime vendor); field web vitals; GitHub protections read back in the live repository; the shared-identity gap closed; release record appended for each released environment. Product gaps are tracked by the Orchestrator.

## OPERATIONS_RECEIPT

The human receipt confirms: the operations owner and support hours above, the alert destination, the runbooks read, the rollback runbook understood, and the go-live evidence list accepted or scheduled. Staging or demo approval never authorizes production.
