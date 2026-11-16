# Submit check: PASS

- Commit: `3aa47acca8382173912f0af145f8349b5e960026` on branch TASK-075
- Base: `origin/dev` at `ebbfc59291903ee389325afdc9b529ab734746c1`
- Run at: 2026-11-16 11:52 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 15 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 9 |
| `pnpm --filter @shroomap/ui test` | 0 | 11 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/comp-upload && cd ../.. && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/comp-upload/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/comp-upload/lcov.info` | 0 | 16 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/comp-upload/e2e-junit.xml REPORT_DIR=reports/comp-upload env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-075 --reporter=junit` | 0 | 27 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 9 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/comp-upload/junit.xml` | 187 | 0 | 0 | pass |
| `apps/web/reports/comp-upload/e2e-junit.xml` | 4 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/comp-upload/lcov.info` | lcov | 98.83% (min 75) | 97.69% (min 70) | 96.53% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-075/screenshots/`: 95 bytes
