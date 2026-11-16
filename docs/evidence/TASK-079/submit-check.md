# Submit check: PASS

- Commit: `80cbce9a819aac4ddfd56dcbb335ff85efd8cdfe` on `feature/AIU-159-task-079-operator-shell-header-sidebar-rail-tab-bar-key-badge-skip-link-toast-region-cmp-030`
- Base: `origin/dev` at `f2203fca5fee73431aeed33ceb1de1fe8cae0d65`
- Run at: 2026-11-16 13:57 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 20 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 17 |
| `pnpm --filter @shroomap/ui test` | 0 | 29 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/shell-op && cd ../.. && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/shell-op/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/shell-op/lcov.info` | 0 | 43 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/shell-op/e2e-junit.xml REPORT_DIR=reports/shell-op WEB_PORT=3179 E2E_API_PORT=4179 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu152_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-079 --reporter=junit` | 0 | 71 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 12 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/shell-op/junit.xml` | 329 | 0 | 0 | pass |
| `apps/web/reports/shell-op/e2e-junit.xml` | 9 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/shell-op/lcov.info` | lcov | 97.40% (min 75) | 96.12% (min 70) | 93.77% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-079/screenshots/`: 805 bytes
