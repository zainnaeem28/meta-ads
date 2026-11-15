# TASK-024 evidence: platform/db

Official check report: `submit-check.md` (also uploaded on the task). Design choices and deviations: `decision-log.md`.

| Acceptance | Proof |
| --- | --- |
| Two connections prove lock order and `lock_timeout` | `apps/api/src/platform/db/db.integration.test.ts` (advisory locks with two connections; order violation refused before PostgreSQL) |
| Transaction helper rejects an egress call inside a lock-holding transaction | same file, "egress inside a lock-holding transaction" (a local server receives zero requests) |
| Test helper leaves no database and refuses non-test servers | same file, "test database helper"; unit guard in `test-database.test.ts` |
| `drizzle-kit push` and unprojected `provider_keys` select fail the lint | `scripts/ci/lint-db.sh`; negative probes in `lint-db.test.ts` |
| Real entry point on real PostgreSQL | `startup.integration.test.ts`: `dist/main.api.js` fails startup for a missing database, opens and closes its pool when it starts; `dist/database/seed.js` refuses and counts |
| TC-OPS-03 migration commands | `migrations.integration.test.ts`: generate (exact name, journal, incremental), `drizzle-kit migrate` twice on a clean database, seed rerun and rollback |

Follow-ups for other owners (outside this ticket's paths): `platform/egress` should call `assertNoEgress` from `platform/db` before each request; `scripts/ci/lint.sh` should call `scripts/ci/lint-db.sh`; the jobs ticket provides `database/jobs-migrate.ts`.
