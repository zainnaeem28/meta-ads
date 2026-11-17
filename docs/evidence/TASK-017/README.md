# TASK-017 evidence: operational documentation

Deliverables: `README.md`, `RUN-GUIDE.md`, `docs/ops/ROLLBACK-RUNBOOK.md`, `docs/ops/OPERATIONS-HANDOFF.md`, `docs/ops/owner-items.md`, and the check `scripts/ci/docs-check.sh`.

| File | What it is |
| --- | --- |
| `guide-run.txt` | Output of `run-guide.sh`: the guide's steps run for real (install, local configuration, role provisioning with the guide's own SQL, build, migrate 10 of 10, jobs migrate, seed twice, price table, ledger grant, api, worker and web started, health checks, the operator commands and their audit events, docs-check 17 of 17) |
| `run-guide.sh` | The script that produced it |
| `negative-probes.txt`, `negative-probes.sh` | Ten damaged facts, each caught by `docs-check.sh`; the restored files pass again |
| `register-snapshot.tsv` | The closed owner decision register of DELIVERY-PLAN §5 (revision `cdd276f7-a482-434f-9e68-1fce0a116da0`): ID and status per row. `docs-check.sh` diffs `docs/ops/owner-items.md` against it |

## What was not run, and why

- **The Docker Compose stack (RUN-GUIDE.md step 3) was not started.** This environment has no Docker and no permission to start a PostgreSQL. The shared test PostgreSQL stood in for the compose database, so the guide's `docker compose ... exec postgres psql` lines ran as `psql` against that server with run-suffixed role and database names (the server holds other runs' `app_*` roles, and migration 0001 hard-codes them, so its role names were renamed in a copy for this run). MinIO and the provider stubs were not started either: the api, worker and web start and answer without them, and no storage or provider call was made. **The Integrator's run of the guide on a clean clone with Docker is the first run of step 3 and of the unsuffixed role names.**
- Ports 4010 and 3010 were used instead of 4000 and 3000.
- The baselines of RUN-GUIDE.md section 10 were not re-run by this ticket; they are the existing wrappers. `lint.sh` was run once: it fails on `dev` for reasons outside this ticket (below).

## Findings for other owners (change requests: outside this ticket's allowed paths)

| ID | Finding | Evidence | Suggested owner |
| --- | --- | --- | --- |
| CR-017-1 | `db:seed --dataset=reference` runs **0 steps**: `priceTableSeedStep()` (`apps/api/src/modules/usage/infrastructure/price-table-file.ts`) exists and is tested, but nothing appends it to `seedSteps` (`apps/api/src/database/index.ts`). The worker then refuses to start on a clean database: `config error: price_table has no row effective now for openai local-stub-text`. The guide loads `config/price-table.json` with a one-line `psql` insert until it is wired. The release order in `docs/ops/release.md` (seed inside `migrate-jobs`) has the same hole in a real environment | `guide-run.txt` section 6 | Usage module owner (TASK-044) or the seed owner |
| CR-017-2 | `/health/ready` answers 503 (`schema_head`) on a freshly migrated database because `app_api` has no `USAGE` on schema `drizzle` and no `SELECT` on `drizzle.__drizzle_migrations` (finding F-DR-3 of the restore drill, still open). The guide grants it by hand | `guide-run.txt` section 6 | Platform or health ticket (TASK-061) or the release migrate step |
| CR-017-3 | The local development stack (`docker/compose.dev.yml`) creates only the `postgres` superuser, but migration 0001 refuses to run unless `app_migrator`, `app_api`, `app_worker` and `app_backup` exist with exact attributes. The guide carries the provisioning SQL inline. A compose init script (and the `.env.example` URLs naming the role of each process) would remove four manual steps | RUN-GUIDE.md section 4 | DevOps (TASK-008) |
| CR-017-4 | `pnpm lint` fails on `dev` (ESLint: `docs/evidence/TASK-091..094/e2e-with-database.mjs`, `process` undefined) and `pnpm format:check` reports 465 files, so `scripts/ci/lint.sh` fails on an untouched clone | `pnpm lint`, `pnpm format:check` on `9353d72` | Authors of those tickets; Orchestrator |
| CR-017-5 | `pnpm --filter @shroomap/api db:check-history` fails on `dev` (compensating fixtures for 0020..0090 missing; finding F-DR-4) | `docs/ops/restore-drill.md` | TASK-026 owner |
| CR-017-6 | The register (DELIVERY-PLAN §5, OD-07) says `infra/render/render.yaml` is built; the file does not exist. `docs/ops/release.md` says the owner creates the services by hand, which this documentation follows | `ls infra` | TASK-018 owner |
| CR-017-7 | `scripts/ci/docs-check.sh` is outside this ticket's allowed paths but is the ticket's required check, so it was created here | | Orchestrator to accept the path |

## Register against the owner-item list

`register-snapshot.tsv` has 35 rows (20 of them `default applied (autonomous)`); `docs/ops/owner-items.md` lists the same 35 IDs with the same statuses, and `docs-check.sh` fails on any difference (probes 1 and 2).
