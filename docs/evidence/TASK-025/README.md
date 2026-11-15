# TASK-025 evidence: M0001 platform migration and the backup-identity grants suite

Official check report: `submit-check.md`. Decisions and deviations: `decision-log.md`.

| Acceptance | Proof |
| --- | --- |
| `db:migrate` applies the range to a clean database, a second run changes nothing | `apps/api/tests/integration/migrations/platform-migration.integration.test.ts`, "M0001 through drizzle-kit migrate" (the `drizzle-kit migrate` CLI as `app_migrator`; ledger and ACL snapshot equal after the second run) |
| TC-BKP-01 | "app_backup reads everything": SELECT on every table and sequence of `public` and `pgboss`, `provider_keys.ciphertext`, `nonce`, `wrapped_dek`; `pg_dump` exits 0 |
| TC-BKP-02, 05, 06 | "app_backup is read-only": 40+ refused statements (42501, run in `READ WRITE` transactions), privilege catalogue probes, `pg_terminate_backend`, unchanged counts and sequence; later table readable without a grant |
| TC-BKP-03, 04 | "roles as provisioned": attributes, no memberships (predefined roles included), third connection refused (53300); one `pg_auth_members` row, `host_admin`, ADMIN, no INHERIT, no SET; `SET ROLE` refused. Fixture: the admin is a non-superuser `CREATEROLE` role |
| TC-BKP-07 | queue created by the `jobs:migrate` step (miniature in `support/harness.ts`) is in the next `pg_dump` as `app_backup` |
| TC-BKP-08 | runtime roles: USAGE and DML only, send/fetch/complete/schedule/supervise work, partitioned `createQueue` and a pg-boss migrate start refused, a missing catalogue queue is detected |
| TC-BKP-09 (a, c) | `pg_dump` (row security off, never `--enable-row-security`) fails and names the table when a probe table has RLS and no policy, and completes without it |
| TC-BKP-10 | connect to another database: no object grant there; refused when `CONNECT FROM PUBLIC` is revoked |
| TC-BKP-11 | the migration refuses and creates nothing when a role, the `app_backup` read-only default, the runtime `search_path` default is missing or `app_backup` has a membership |
| `app_api` no DDL, cannot update `audit_events`, cannot select `provider_keys.ciphertext` | "later-migration scaffold" (stand-in tables as M0002/M0004 will create them) |
| Real entry points | `dist/database/seed.js` as `app_migrator` and `dist/main.api.js` as `app_api` on the migrated database |

Not covered by this ticket (no artifact exists yet): TC-BKP-09(b), TC-BKP-12, TC-BKP-13 test the backup script and image, which the DevOps backup ticket delivers; TC-BKP-12/13 and the TC-BKP-09(b) flag scan must be run there. Gap G-1 and the other follow-ups are in `decision-log.md`.

Run needs `pg_dump` 16+ (`PG_CLIENT_ROOT=<dpkg -x root>` or on `PATH`) and the shared test PostgreSQL; every run creates `t025_<sfx>` and run-suffixed roles and drops them (checked in `afterAll`).
