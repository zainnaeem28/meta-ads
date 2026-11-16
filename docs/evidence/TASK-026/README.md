# TASK-026 evidence: migration check harness (`db:check-history`)

Official check report: `submit-check.md`. Run: `CI=1 PG_CLIENT_ROOT=<dpkg -x root> pnpm --filter @shroomap/api db:check-history` (needs `pg_dump` 16+ for the later-release upgrade test, and the shared test PostgreSQL).

Entry: `scripts/ci/db-check-history.sh` runs `apps/api/tests/integration/migrations-check/history.migcheck.test.ts` (own vitest config, not part of `test:integration`), writes `apps/api/reports/migcheck/junit.xml` and `lcov.info`, and records the result with `record` like the other CI wrappers. Each test uses a uniquely named database and run-suffixed roles (the TASK-025 provisioning) and drops them in `afterAll`, asserting nothing is left.

| Acceptance / test | Proof (`support/check.ts` function, test) |
| --- | --- |
| Full history on an empty database (TC-OPS-03) | `checkCleanHistory`: `drizzle-kit migrate` as `app_migrator`, ledger count equals the journal |
| Upgrade from the previous release with synthetic data | `checkUpgrade` restores `fixtures/previous-release/{snapshot,synthetic-data}.sql` (empty at the first release, `release.json` tag null), then migrates; every synthetic row must survive (a new row may add columns). Exercised for real with a later-release simulation (release 1 dumped with its ledger, `0002` expand migration, rows survive) |
| Rollback check (TC-NFR-05) | `checkRollback`: copy of the migrated database (`CREATE DATABASE ... TEMPLATE`), `fixtures/compensating/NNNN.sql` applied newest first, structure and data must equal the previous release, source database untouched. Every migration after the previous release needs a compensating file. After go-live the runbook restores from the on-demand export instead |
| Seed rerun | `checkSeedRerun` on `runSeed` and on the real `seed.ts` `main` (config loaded as the release process); the data fingerprint of every public table must not change |
| Expand/contract for later releases | `checkExpandContract`: migrations numbered above `lastMigration` may not drop, rename, retype, set NOT NULL, truncate or delete unless the file carries `-- contract: <ticket>` |
| Grants | `checkGrants`: `app_backup` SELECT everywhere and no write, `api`/`worker` SELECT and no TRUNCATE, nobody creates in `public` |
| Negative probes | broken migration (`CREATE TABL`), revoked grant, table granted to nobody plus stray write grants, non-idempotent seed, missing/incomplete/failing compensating migration, contracting migration, lossy upgrade, bad fixtures: each is reported |
| Junit the gate reads | `apps/api/reports/migcheck/junit.xml`, passed as `--junit`; coverage of the harness as `--coverage` |

At each release: regenerate the fixtures (instructions in `fixtures/previous-release/release.json`), and add a compensating file per new migration.

Limits and change requests (outside the allowed paths, for the Orchestrator): `apps/api/package.json` gets the `db:check-history` script (one line, needed by the required command); the Integrator's combined-check list and the quality policy should add `pnpm --filter @shroomap/api db:check-history` and `apps/api/reports/migcheck/junit.xml`. The "real entry point" for this ticket is the seed `main` and the `drizzle-kit migrate` CLI (the check has no API or worker path of its own).
