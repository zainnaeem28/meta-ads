# Submit check: PASS

- Commit: `afc8e78e4fd379b27ce011ff930a67397760f249` on `feature/AIU-152-task-078-layout-page-header-page-grid-auth-shell-cmp-033-034-032`
- Base: `origin/dev` at `c4a695c36865e04c3165250b95b764aca4ec043e`
- Run at: 2026-11-16 12:43 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 12 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 7 |
| `pnpm --filter @shroomap/ui test` | 0 | 23 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/layout && cd ../.. && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/layout/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/layout/lcov.info` | 0 | 23 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/layout/e2e-junit.xml REPORT_DIR=reports/layout WEB_PORT=3152 E2E_API_PORT=4152 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu152_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-078 --reporter=junit` | 0 | 27 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 9 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/layout/junit.xml` | 267 | 0 | 0 | pass |
| `apps/web/reports/layout/e2e-junit.xml` | 5 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/layout/lcov.info` | lcov | 97.79% (min 75) | 96.25% (min 70) | 94.49% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-078/screenshots/`: 85 bytes
