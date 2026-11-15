# Submit check: PASS

- Commit: `1a4b8f5cc3d3f94e63c9abe1cd5d45417a664e1f` on `feature/AIU-81`
- Base: `origin/dev` at `ebaacadeaf8082a23b3c2a3fb869227f2ebcc7b1`
- Run at: 2026-11-15 23:04 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api lint` | 0 | 4 |
| `pnpm --filter @shroomap/api typecheck` | 0 | 5 |
| `pnpm --filter @shroomap/api test:unit` | 0 | 9 |
| `pnpm --filter @shroomap/api test:integration` | 0 | 72 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/contract.sh` | 0 | 11 |
| `scripts/ci/lint-db.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 20 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/api/reports/db/junit.xml` | 379 | 0 | 9 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/api/reports/db/lcov.info` | lcov | 98.61% (min 90) | 94.07% (min 85) | 96.44% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-024/decision-log.md`: 3409 bytes
- `docs/evidence/TASK-024/README.md`: 1496 bytes
