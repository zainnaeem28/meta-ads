# TASK-012 evidence: restore drill (DO-07b)

Script: `scripts/backup/restore-drill.sh --local`. Operator guide and findings: `docs/ops/restore-drill.md`. Official check report: `submit-check.md`.

| Acceptance | Proof |
| --- | --- |
| Drill record with measured restore time and data lost; fails when data lost exceeds 24 h or the smoke journey fails | `drill-record.md` (a copy of `reports/backup/drill-record.md` from the run in `drill-run.txt`: PASS, restore time, data lost window, rows lost); `drill-run.txt` (the real run, output); `negative-data-loss.txt` (`--simulate-data-loss-hours 25` exits 1 on the RPO gate); the smoke step fails the run when `/health/ready` is not 200 or a protected route answers 5xx |
| An erased synthetic user stays erased after restore (T-22, TC-BKP-26) | Step 7 of `drill-record.md`: the user is present right after the restore, absent everywhere after reconciliation from the live and mirrored ledger; `negative-skip-reconcile.txt` (`--simulate-skip-reconcile` fails with "erased user still present") |
| KEK canary (KC-6) | Step 8: sealed canary row opens with the held synthetic KEK_V1; wrong key and moved AAD fail |
| Migration rollback check on the full history | Step 2: every one of the journal's migrations, pre-migration snapshot restored into a new database equals the pre-migration state; compensating migrations verified where they exist |
| Wired into the running product, real entry point | The drill applies the real migrations with `drizzle-kit migrate`, runs the real `jobs:migrate`, dumps as the real `app_backup` role with the backup service's exact `pg_dump` arguments, restores, and starts the built api (`node dist/main.api.js`) on the restored database |

JUnit: `reports/backup/drill-junit.xml` (not committed; uploaded with the report).

Decisions and open items: see "Findings" in `docs/ops/restore-drill.md` (F-DR-1 to F-DR-4). They need change requests outside this ticket's allowed paths: the backup service dump (`--schema=drizzle` or a ledger rebuild step, `--extension=pg_trgm`), a grant for the api role on the drizzle ledger (readiness is 503 on the live database as shipped), and compensating migrations 0020 to 0090 (TASK-026's `db:check-history` fails on `origin/dev`).

Limits: the backup in this drill is the service's dump format and mirror layout written to a local folder, not a run of the `backup` image against MinIO (that run is TASK-011's evidence); the previous application version cannot be started against a rolled-back schema until a release exists, so the rollback check compares structure, grants and rows; FLOW-04 e2e (TASK-107) does not exist yet, so the smoke is the API smoke; the real-environment drill remains go-live evidence.
