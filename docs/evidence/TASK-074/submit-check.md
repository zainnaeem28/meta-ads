# Submit check: PASS

- Commit: `6f4834b7b9b3c5924ce54a52f8bdf2b67d9b5f6f` on `feature/AIU-148-task-074-composites-table-list-card-empty-and-error-state-cmp-016-018-019`
- Base: `origin/dev` at `a0c6f5067d7bd953fd26d18f6f4bd1b3ec0057eb`
- Run at: 2026-11-16 11:15 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 12 |
| `pnpm --filter @shroomap/ui test` | 0 | 18 |
| `cd packages/ui && REPORT_DIR=reports/comp-data pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/comp-data && cd ../.. && cp apps/web/reports/comp-data/ui-junit.xml apps/web/reports/comp-data/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/comp-data/lcov.info` | 0 | 18 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/comp-data/e2e-junit.xml REPORT_DIR=reports/comp-data WEB_PORT=3148 E2E_API_PORT=4148 E2E_DATABASE_URL=postgres://app_api:pw@test-db:5432/aiu148_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-074 --reporter=junit` | 0 | 22 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 22 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/comp-data/junit.xml` | 196 | 0 | 0 | pass |
| `apps/web/reports/comp-data/e2e-junit.xml` | 5 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/comp-data/lcov.info` | lcov | 98.45% (min 75) | 97.22% (min 70) | 96.32% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-074/screenshots/`: 91 bytes
