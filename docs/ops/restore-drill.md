# Restore drill (`scripts/backup/restore-drill.sh`)

DO-07b (DEVOPS-PLAN §10.3 "Restore baseline", §10.4 item 7 and KC-6; QUALITY-RELEASE-PLAN §6). Cases TC-NFR-05, TC-OPS-04, TC-BKP-26, T-22. This is the agent baseline on a disposable test server with synthetic data and a synthetic KEK. The same drill in the real environment, with RTO and RPO sign-off by the owner, stays go-live evidence (TC-H-08). A dump is not "restored" until a drill has run.

```
CI=1 scripts/backup/restore-drill.sh --local [--record FILE] [--junit FILE] [--keep]
                                     [--simulate-data-loss-hours N] [--simulate-skip-reconcile]
```

Writes the drill record (`reports/backup/drill-record.md` by default, not committed; the committed copy of a run is `docs/evidence/TASK-012/drill-record.md`) and a JUnit file (`reports/backup/drill-junit.xml`), removes its databases, roles and work folder (it holds the synthetic KEK and age identity) on exit, and exits 0 only when every step passed. `--local` is required; the script refuses a non-test host. Needs `psql`, `pg_dump`/`pg_restore` 17, `node`, `pnpm`, `openssl`, `curl`, the shared test PostgreSQL (`DRILL_PG_ADMIN_URL`, default `postgres://postgres@test-db:5432/postgres`; `PG_CLIENT_ROOT` for an unpacked PostgreSQL 17 client) and `age` (`AGE_BIN`, `PATH`, or the checksum-pinned release archive, as the backup tests do). `--simulate-data-loss-hours` and `--simulate-skip-reconcile` inject a fault to prove the gates; they must make the drill fail.

## Steps

| # | Step | What it proves |
| - | ---- | -------------- |
| 1 | Provision | Four run-suffixed roles and a database created the way the host does (`app_backup` read-only, connection limit 2) |
| 2 | Migration rollback check, full history | For each of the migrations in the journal: the state before it is fingerprinted and dumped (the pre-migration snapshot), the real `drizzle-kit migrate` applies it, the snapshot is restored into a new database and must equal the pre-migration state (structure from the catalogs, grants and every row), and the migration must have changed the structure. Where a compensating forward migration exists (`apps/api/tests/integration/migrations-check/fixtures/compensating/NNNN.sql`) it is applied to a copy and must also give the pre-migration structure. Ends with `jobs:migrate` (pg-boss) as the release does |
| 3 | Seed | Three users, a sealed canary `provider_keys` row (KEK_V1), an invitation and an access request of the user erased later, campaigns, and objects under `u/` and `q/` |
| 4 | Backup | The dump the backup service takes (`pg_dump --format=custom --schema=public --schema=pgboss` as `app_backup`) piped into `age`, a media mirror with a SHA-256 manifest (`u/` only), the ledger mirror, and a scan that no key material is in the backup tree |
| 5 | After the backup | Rows are written (lost by design), a user is erased with a ledger object (`erasure/<ts>-<runId>`, ids and kind only), the smoke is run on the live database as a baseline, then the database and the app bucket are dropped |
| 6 | Restore | Decrypt with the escrowed identity, restore into a new empty database in sections, rebuild the drizzle ledger, verify row counts against the backup moment, constraints, extension, roles and grants (`app_backup` cannot write), restore media with SHA-256 checks |
| 7 | Ledger reconciliation (T-22) | Right after the restore the erased user is back (the test is meaningful); every ledger subject, from the live ledger and the backup mirror, is erased again (account: invitations, access requests, user and cascade, objects under `u/` and `q/`; campaign: the row); the subject is absent everywhere, the others are intact, a second pass changes nothing |
| 8 | KEK canary (KC-6) | The canary row, read as `app_worker`, opens with the held KEK_V1 (public key fingerprint matches), a different key fails and a moved AAD fails; the key lives in a custody folder outside the backup tree |
| 9 | Smoke journey | The built api (`node dist/main.api.js`, as `app_api`) starts on the restored database; `/health/live` and `/health/ready` (schema head and pgboss queue) answer 200; protected routes answer 401. FLOW-04 e2e (TASK-107) replaces this when it exists |
| 10 | RPO and RTO | Data lost = backup moment to the loss of the database, plus the rows written in between; fails above 24 h. Restore time = decrypt through smoke; fails above 8 h |

The record lists each step with seconds and notes. Restore time of an empty-ish synthetic database is seconds; the 8 h RTO is dominated by decision and cutover time (DEVOPS-PLAN §10.3), which the real-environment drill measures.

## Findings from the drill (change requests, outside this ticket's paths)

- **F-DR-1 (TASK-011 backup service).** The dump (`public`, `pgboss`) carries no `drizzle` schema, so a restored database has no migration ledger: readiness reports schema head 0 and `db:migrate` would re-run every migration over existing tables. The drill rebuilds the ledger from the journal (hash of each file, `when`), compares it with the lost database's ledger, and it is identical. Procedure for a real restore: do the same, or dump the ledger table as a separate read grant. `app_backup` has no access to the `drizzle` schema by design (stack validation F-3).
- **F-DR-2 (TASK-011).** `pg_dump --schema=public` does not carry the `pg_trgm` extension, so a one-pass `pg_restore` fails on the trigram indexes. The restore runs in sections: `pre-data`, `CREATE EXTENSION pg_trgm SCHEMA public`, `data`, `post-data`. Alternative: add `--extension=pg_trgm` to the dump.
- **F-DR-3 (platform, not a restore defect).** On the live database as shipped, `/health/ready` answers 503 (`schema_head`): `app_api` has no `USAGE` on schema `drizzle` and no `SELECT` on `drizzle.__drizzle_migrations`, which the health service reads. A release step has to grant it (the drill grants it on the live copy and in the ledger rebuild). Owner: Orchestrator to route to the platform/health ticket (TASK-061) or a migration/release step.
- **F-DR-4 (TASK-026).** `pnpm --filter @shroomap/api db:check-history` fails on `origin/dev` today (5 of 25 tests): compensating fixtures exist for 0001 and 0010 only, and the previous-release fixture checks are out of date. The drill's own rollback check does not depend on them: it restores the pre-migration snapshot for every migration and applies a compensating migration only where one exists. Compensating files for 0020 to 0090 are missing.
- A restored database does not carry the template's `PUBLIC` `USAGE` on schema `public`; every role has its own grant, so nothing changes in effect. The structure comparison ignores it.

## Real-environment drill (go-live evidence, TC-H-08)

Same steps against a scratch environment: the managed database backup and the logical dump from the real backup bucket, the real age identity (two custodians present, KC-3), the real KEK custody copy unsealed under the two-person rule to open the restored canary row through the worker (KC-6 evidence: date, version, copy ID, custodians, tool and version, fingerprint match, canary pass, hash match, wipe confirmation, sign-off; no key material), the smoke journeys, and the measured restore time and data lost against the 8 h and 24 h objectives. Record in `OPERATIONS-HANDOFF.md`.
