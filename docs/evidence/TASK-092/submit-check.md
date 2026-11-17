# Submit check: PASS

- Commit: `102c45aee3a6f1ab5d1b4385e3455276173ee44b` on `feature/AIU-170-task-092-new-brief-wizard-2-2-product-image-upload-and-analysis-review-and-generate-screen-006`
- Base: `origin/dev` at `f42b794028941df5cb9206bf66c4087c29c65b30`
- Run at: 2026-11-17 02:20 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 4 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 15 |
| `cd apps/web && REPORT_DIR=reports/fe-screen-006b pnpm test` | 0 | 29 |
| `pnpm --filter @shroomap/ui test` | 0 | 34 |
| `node docs/evidence/TASK-092/e2e-with-database.mjs` | 0 | 68 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 17 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-006b/junit.xml` | 318 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-006b/e2e-junit.xml` | 25 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-006b/lcov.info` | lcov | 89.19% (min 75) | 84.58% (min 70) | 83.23% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-092/screenshots/`: 1045 bytes
