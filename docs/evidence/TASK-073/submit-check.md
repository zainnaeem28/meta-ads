# Submit check: PASS

- Commit: `d437b3929e05158820f6d27d94e0b7eb6ea6aa3f` on branch AIU-143 (TASK-073)
- Base: `origin/dev` at `55161522225685415c1ba5171bb3494cda79c089`
- Run at: 2026-11-16 10:52 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 8 |
| `pnpm --filter @shroomap/ui test` | 0 | 9 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/comp-nav && cd ../.. && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/comp-nav/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/comp-nav/lcov.info` | 0 | 8 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/comp-nav/e2e-junit.xml REPORT_DIR=reports/comp-nav env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-073 --reporter=junit` | 0 | 17 |
| `scripts/ci/token-lint.sh` | 0 | 0 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 6 |
| `scripts/ci/deps.sh` | 0 | 2 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/comp-nav/junit.xml` | 149 | 0 | 0 | pass |
| `apps/web/reports/comp-nav/e2e-junit.xml` | 5 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/comp-nav/lcov.info` | lcov | 98.88% (min 75) | 98.78% (min 70) | 96.88% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-073/screenshots/`: 89 bytes
