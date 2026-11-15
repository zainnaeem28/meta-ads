# Submit check: PASS

- Commit: `139ff5fe5063e883b3590cac1d9388eb543d9e55` on the ticket branch
- Base: `origin/dev` at `6def2fadf400cfe06b9d17503b84d04febfde604`
- Run at: 2026-11-15 23:49 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api lint; pnpm --filter @shroomap/api typecheck; pnpm --filter @shroomap/api test:unit; pnpm --filter @shroomap/api test:integration; scripts/ci/layers.sh; scripts/ci/contract.sh; scripts/ci/lint-db.sh; scripts/ci/sast.sh; scripts/ci/deps.sh; scripts/ci/secrets.sh` | 0 | 103 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/api/reports/migrations/junit.xml` | 85 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/api/reports/migrations/lcov.info` | lcov | 100.00% (min 80) | 78.26% (min 75) | 91.18% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-025/integration-check.md`: 12 bytes

- `apps/api/src/database/migrations`: no duplicate numbers
