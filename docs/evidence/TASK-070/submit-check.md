# Submit check: PASS

- Commit: `098ff0d6467e477973dbfb15f536e1855e49378a` on the ticket branch
- Base: `origin/dev` at `21da9ad56a192b55ea249a77340e0ed2ef4b9377`
- Run at: 2026-11-16 10:24 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 8 |
| `pnpm --filter @shroomap/ui test` | 0 | 6 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/prim-b --coverage.include=src/components/cmp-00[78]/**/*.tsx && cd ../.. && mkdir -p apps/web/reports/prim-b && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/prim-b/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/prim-b/lcov.info` | 0 | 5 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/prim-b/e2e-junit.xml pnpm exec playwright test --project=chromium --grep @TASK-070 --reporter=junit` | 0 | 15 |
| `scripts/ci/token-lint.sh` | 0 | 0 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 20 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/prim-b/junit.xml` | 128 | 0 | 0 | pass |
| `apps/web/reports/prim-b/e2e-junit.xml` | 6 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/prim-b/lcov.info` | lcov | 100.00% (min 75) | 100.00% (min 70) | 100.00% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-070/screenshots/`: 85 bytes
