# Submit check: PASS

- Commit: `aba890d48d41cb7b661792fe6202c4dbf9ba5019` on `feature/AIU-179-task-103-admin-usage-report-screen-015`
- Base: `origin/dev` at `84795ded6577d97298cbdc1b861c0174510339dc`
- Run at: 2026-11-17 11:59 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 4 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 13 |
| `pnpm --filter @shroomap/web test` | 0 | 39 |
| `pnpm --filter @shroomap/ui test` | 0 | 29 |
| `cd apps/web && pnpm exec playwright test --project=chromium --grep @TASK-103` | 0 | 52 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 3 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-015/junit.xml` | 392 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-015/e2e-junit.xml` | 19 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-015/lcov.info` | lcov | 90.97% (min 75) | 84.63% (min 70) | 85.23% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-103/screenshots/`: 665 bytes
