# Submit check: PASS

- Commit: `f3003b64e8d2b37d3edf6642c14764dff902830a` on `feature/AIU-232-task-098-follow-up-pass-new-providerkeycard-operatorshell-props-in-fe-screen-010-uxv-1-uxv-3-uxv-6`
- Base: `origin/dev` at `19669f8c638533d72d969b544f0ae03871a780ea`
- Run at: 2026-11-16 19:44 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 2 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 2 |
| `cd apps/web && REPORT_DIR=reports/fe-screen-010 pnpm test` | 0 | 10 |
| `pnpm --filter @shroomap/ui test` | 0 | 18 |
| `cd apps/web && REPORT_DIR=reports/fe-screen-010 PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/fe-screen-010/e2e-junit.xml WEB_PORT=3232 E2E_API_PORT=4232 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu232_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-098 --reporter=junit` | 0 | 36 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 6 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-010/junit.xml` | 246 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-010/e2e-junit.xml` | 30 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-010/lcov.info` | lcov | 95.30% (min 75) | 91.38% (min 70) | 89.35% | not measured |

## Evidence in the commit

- `docs/evidence/TASK-098/screenshots/default-1440.png`: 104129 bytes
