# Submit check: PASS

- Commit: `b1061539b69bc4a4ceb2052cfdca2776e2f7afbd` on `TASK-094 branch`
- Base: `origin/dev` at `f42b794028941df5cb9206bf66c4087c29c65b30`
- Run at: 2026-11-17 02:22 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint; pnpm --filter @shroomap/web typecheck; REPORT_DIR=reports/fe-screen-007b pnpm --filter @shroomap/web test; pnpm --filter @shroomap/ui test; node docs/evidence/TASK-094/e2e-with-database.mjs; scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 103 |
| `scripts/ci/sast.sh` | 0 | 8 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-007b/junit.xml` | 320 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-007b/e2e-junit.xml` | 26 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-007b/lcov.info` | lcov | 94.31% (min 75) | 87.52% (min 70) | 89.27% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-094/screenshots/`: 839 bytes
