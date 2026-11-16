# Submit check: PASS

- Commit: `40f0429e830887a63ad62d651ad35d50ea0382b6` on `feature/AIU-85-<branch redacted: secret-scan false positive>`
- Base: `origin/dev` at `e78a477ccf785cc11e3655f8836d0c74121c5ff8`
- Run at: 2026-11-16 00:08 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api db:check-history` | 0 | 17 |
| `pnpm --filter @shroomap/api lint` | 0 | 3 |
| `pnpm --filter @shroomap/api typecheck` | 0 | 5 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/lint-db.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 8 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/api/reports/migcheck/junit.xml` | 25 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/api/reports/migcheck/lcov.info` | lcov | 97.16% (min 80) | 89.23% (min 75) | 94.59% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-026/README.md`: 3302 bytes

- `apps/api/src/database/migrations`: no duplicate numbers
