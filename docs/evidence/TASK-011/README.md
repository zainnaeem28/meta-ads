# TASK-011 evidence: backup service (DO-07a)

Official check report: `submit-check.md`. Decisions, deviations and open items: `decision-log.md`. Operator guide: `docs/ops/backup.md`.

| Acceptance | Proof |
| --- | --- |
| Backup run end to end through the real entry point, result with counts and duration | `backup-run.txt` (`node src/main.ts` against MinIO and the shared test PostgreSQL, twice) and `scripts/backup/tests/e2e.test.ts` |
| TC-BKP-12 forbidden variables | `tests/config.test.ts` (unit and the real entry point, exit 78) |
| TC-BKP-13, TC-BKP-09 (b) | `tests/scan.test.ts` |
| TC-BKP-14, 15, 16, 25 | `tests/buckets.test.ts` |
| TC-BKP-01 (dump), 07, 09 (a, c), 10, 21, 23, 24 | `tests/dump.test.ts` |
| TC-BKP-17 to 20, 22, TC-LED-01, 02, 04 to 06 | `tests/mirror.test.ts` |
| Lock and lifecycle rules as an applied-by-owner plan; blocking finding when the host offers no lock | `docs/ops/backup.md` (plan, `verify-locks.ts`, finding F-1) |

JUnit and coverage: `reports/backup/junit.xml`, `reports/backup/lcov.info` (not committed; uploaded with the submit-check report).
