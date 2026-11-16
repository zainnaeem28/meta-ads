# Submit check: PASS

- Commit: `7e2dee150b51f74e232ffa5fe133424a7c233a1f` on `feature/AIU-152-task-078-layout-page-header-page-grid-auth-shell-cmp-033-034-032`
- Base: `origin/dev` at `234154cf25fe40ffdd7d0dfe3f69241459c87591`
- Run at: 2026-11-16 13:21 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 18 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 17 |
| `pnpm --filter @shroomap/ui test` | 0 | 24 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/layout && cd ../.. && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/layout/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/layout/lcov.info` | 0 | 27 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/layout/e2e-junit.xml REPORT_DIR=reports/layout WEB_PORT=3152 E2E_API_PORT=4152 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu152_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-078 --reporter=junit` | 0 | 32 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 11 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/layout/junit.xml` | 316 | 0 | 0 | pass |
| `apps/web/reports/layout/e2e-junit.xml` | 5 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/layout/lcov.info` | lcov | 97.74% (min 75) | 96.61% (min 70) | 93.88% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-078/screenshots/`: 85 bytes
