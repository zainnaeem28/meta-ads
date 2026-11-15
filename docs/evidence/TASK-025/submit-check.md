# Submit check: PASS

- Commit: `a56915d2fb07ccb7a97a98494723bce32c9e580a` on the ticket branch
- Base: `origin/dev` at `b5a0e4a842f28866b8f374f67bfdb900ee86a7ee`
- Run at: 2026-11-15 23:22 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api lint` | 0 | 2 |
| `pnpm --filter @shroomap/api typecheck` | 0 | 4 |
| `pnpm --filter @shroomap/api test:unit` | 0 | 9 |
| `pnpm --filter @shroomap/api test:integration` | 0 | 101 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/contract.sh` | 0 | 12 |
| `scripts/ci/lint-db.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 11 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

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

- `docs/evidence/TASK-025/README.md`: 2796 bytes
- `docs/evidence/TASK-025/decision-log.md`: 2693 bytes

- `apps/api/src/database/migrations`: no duplicate numbers
