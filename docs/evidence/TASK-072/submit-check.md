# Submit check: PASS

- Commit: `d1a3d78940b55da58f11fa5ea7dcf5ae90226385` on `feature/AIU-149-task-072-composites-dialog-and-menu-cmp-013-020`
- Base: `origin/dev` at `7d72f72a2c5a25a612d90776a7c47ec9e0569410`
- Run at: 2026-11-16 11:59 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 6 |
| `pnpm --filter @shroomap/ui test` | 0 | 14 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/comp-overlay && cd ../.. && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/comp-overlay/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/comp-overlay/lcov.info` | 0 | 14 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/comp-overlay/e2e-junit.xml REPORT_DIR=reports/comp-overlay env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-072 --reporter=junit` | 0 | 24 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 6 |
| `scripts/ci/deps.sh` | 0 | 2 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/comp-overlay/junit.xml` | 207 | 0 | 0 | pass |
| `apps/web/reports/comp-overlay/e2e-junit.xml` | 6 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/comp-overlay/lcov.info` | lcov | 98.20% (min 75) | 96.66% (min 70) | 95.38% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-072/screenshots/`: 97 bytes
