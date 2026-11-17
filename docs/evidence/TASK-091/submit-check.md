# Submit check: PASS

- Commit: `562a3dfac2da3133dcd5c46fcc26f33c778802b6`
- Base: `origin/dev` at `7e2971cae3793ab503327d73890a2ca02f41a213`
- Run at: 2026-11-16 23:58 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 2 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 2 |
| `cd apps/web && REPORT_DIR=reports/fe-screen-006a pnpm test` | 0 | 15 |
| `pnpm --filter @shroomap/ui test` | 0 | 20 |
| `node docs/evidence/TASK-091/e2e-with-database.mjs` | 0 | 34 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 20 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-006a/junit.xml` | 281 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-006a/e2e-junit.xml` | 20 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-006a/lcov.info` | lcov | 94.06% (min 75) | 89.64% (min 70) | 88.98% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-091/screenshots/`: 829 bytes
