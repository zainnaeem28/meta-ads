# Stack validation step 2: database roles, drizzle-kit migrate and pg-boss on real PostgreSQL

Draft section of the `stack-validation` document (ARCHITECTURE §1.10 step 2). Ticket TASK-002 (AIU-75). Proof output: `docs/evidence/TASK-002/db-proof.txt`; JUnit: `reports/foundation/db-junit.xml` (submit-check report on AIU-75).

## Setup

| Item | Value |
| --- | --- |
| Server | the shared test PostgreSQL, 17.11 (`postgres://postgres@test-db:5432/postgres`) |
| Client | `pg_dump` 17.12 (Debian trixie `postgresql-client-17`, extracted with `dpkg -x`; `PG_CLIENT_ROOT=<root>` or `pg_dump` on `PATH`) |
| pg-boss / drizzle-kit / drizzle-orm / pg | 12.38.2 / 0.31.11 / 0.45.4 / 8.23.1 (exact pins, `tools/foundation-tests/db/package.json`) |
| Run command | `CI=1 pnpm --filter foundation-tests test:db` (needs `pg_dump` 16 or later) |

Each run creates database `t002_<sfx>` and roles `host_admin_<sfx>`, `app_migrator_<sfx>`, `app_api_<sfx>`, `app_worker_<sfx>`, `app_backup_<sfx>` (random 8-hex suffix, random passwords). As at provisioning, the shared server's superuser creates only `host_admin` (`CREATEROLE`, not superuser); `host_admin` then creates the four roles, so the PostgreSQL 16+ creator grant is exercised. The run drops everything in `afterAll` and queries `pg_database` and `pg_roles` for the suffix: the check fails the run if anything is left.

Entry points exercised for real: `drizzle-kit migrate` (the CLI binary, against two CLI-generated migrations in `fixtures/probe/migrations/`) and `jobs-migrate.ts` (the foundation form of `jobs:migrate`, run as a separate Node process under `app_migrator`).

## Result by claim of §1.10 step 2

| Claim | Test (db-roles.test.ts) | Result |
| --- | --- | --- |
| Four roles created as at provisioning, `app_backup` by a non-superuser CREATEROLE admin; attributes, no memberships, connection limit 2 (TC-BKP-03) | `roles as at provisioning` | pass |
| `pg_auth_members` for `app_backup`: one row, `host_admin`, `admin_option` true, `inherit_option` false, `set_option` false; `SET ROLE` refused (TC-BKP-04) | `roles as at provisioning` | pass |
| `app_migrator` runs `drizzle-kit migrate`; `pgboss` schema pre-created and owned by `app_migrator`; re-run is a no-op | `drizzle-kit migrate as app_migrator` | pass |
| pg-boss installs into the pre-created `pgboss` schema; `jobs:migrate` installs and calls `createQueue` for every catalogue queue; idempotent | `jobs:migrate as app_migrator (real entry point)` | pass |
| Runtime roles can send, fetch, complete, schedule and run supervision/maintenance with only USAGE and DML on `pgboss` (no CREATE) | `runtime roles with only USAGE and DML` | pass (`app_api`: send/read; `app_worker`: all of it, on a shared-table queue and a partitioned queue) |
| `createQueue` and a migrate start as `app_worker` and `app_api` are refused (TC-BKP-08) | pre-install and post-install groups | **partly**: see F-1 and F-2 |
| Runtime start fails fast when the schema is missing; a queue missing from the catalogue is detectable by name | pre-install group; `startup check basis` | pass (the application-level fail-closed start is product code, a later ticket) |
| A queue created by `jobs:migrate` then `pg_dump` as `app_backup` succeeds and contains the queue's table (TC-BKP-07) | `queue-then-dump` | pass |
| `app_backup` cannot write, run DDL, `SET ROLE`, `COPY ... TO PROGRAM` or to a file, terminate another role's backend, or `nextval`; counts and sequence unchanged (TC-BKP-02); read-only session default with a `READ WRITE` transaction still refused (TC-BKP-05); a later table is readable without a grant (TC-BKP-06) | `app_backup is read-only` | pass |
| The run drops its database and roles | `afterAll` plus the `leftovers check` | pass (leftovers = `[]`) |

## Findings for the design and for M0001 (TASK-025)

Nothing below is applied to product code in this ticket. Statements marked "candidate" are proven in the test only, as a probe.

- **F-1 (changes a TC-BKP-08 expectation).** With the default privileges M0001 specifies (`SELECT, INSERT, UPDATE, DELETE` on pgboss tables for `app_api` and `app_worker`), `createQueue` for a queue without its own table succeeds for a runtime role: it is one `INSERT` into `pgboss.queue`. Only a partitioned queue (`partition: true`, needs `CREATE TABLE`) is refused with `permission denied for schema pgboss`. The row is readable by `app_backup` and a later `pg_dump` succeeds. The worker's scheduler needs that same INSERT: `Timekeeper.start()` calls `createQueue('__pgboss__send-it')` at every start (`schedule: true`), and revoking INSERT from `app_worker` makes `boss.start()` fail with `permission denied for table queue`. Candidate (proven, runtime flows still pass): in M0001's follow-up or `jobs:migrate`, `REVOKE INSERT, DELETE ON pgboss.queue FROM app_api` and `REVOKE DELETE ON pgboss.queue FROM app_worker`, which refuses `createQueue` for `app_api` entirely and leaves `app_worker` able to insert only plain rows. The table does not exist when M0001 runs, so this cannot live in M0001's default privileges; it belongs after the pg-boss install (`jobs:migrate`). Decision for the Solution Architect: accept "plain queue rows by the worker are harmless; startup check plus catalogue are the control", or require the worker not to schedule. TC-BKP-08 should say "partitioned or DDL queue creation refused; plain createQueue refused for `app_api`".
- **F-2 (changes a TC-BKP-08 expectation).** A pg-boss `migrate: true` start by a runtime role on an up-to-date schema is not refused: it starts and does nothing. It is refused (`permission denied`, nothing created) only when the schema is not installed or is behind. The test proves the refusal on the not-installed state and proves no DDL on the current state.
- **F-3 (M0001 / backup design).** `drizzle-kit migrate` creates the schema `drizzle` with `__drizzle_migrations`. `pg_dump` as `app_backup` of the whole database fails with `permission denied for schema drizzle`. The documented dump is `public` and `pgboss` only (`--schema=public --schema=pgboss`), which passes; but then a restore has no migration history. Recommend M0001 either grants `USAGE` on schema `drizzle` and `SELECT` on `drizzle.__drizzle_migrations` to `app_backup` and the dump includes it, or the restore runbook re-creates the history.
- **F-4 (no extra grant needed).** Beyond `USAGE` on `pgboss` and DML on its tables (default privileges `FOR ROLE app_migrator`), no grant was needed for send, fetch, complete, schedule, supervise and maintenance, on both table kinds. pg-boss creates no sequences. No pg-boss warnings or errors were emitted by the runtime roles.
- **F-5 (environment).** `pg_dump` is not in the shell image and not on the CI image by default; the proof needs a PostgreSQL 16 or later client. Add `postgresql-client-17` to the CI image.
- **F-6 (role names in migrations).** drizzle migrations are static SQL, so the probe uses `{{role}}` tokens rendered per run. M0001 uses the fixed provisioning names; a test database needs the same fixed names or the same rendering step.

## Change requests

The ticket's allowed paths do not include the files that make `pnpm --filter foundation-tests` resolve a workspace package. The minimum was changed and is flagged for the Orchestrator and reviewer: `pnpm-workspace.yaml` (adds `tools/foundation-tests/db`) and `pnpm-lock.yaml` (the importer entry; `pnpm install --frozen-lockfile` verified).
