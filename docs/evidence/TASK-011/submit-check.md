# Submit check: PASS

- Commit: `bc3b6425f0a2e705ada9c7becb1b011d1fd6601b` on branch AIU-133 (name redacted: secret-scan false positive)
- Base: `origin/dev` at `e78a477ccf785cc11e3655f8836d0c74121c5ff8`
- Run at: 2026-11-16 00:07 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter backup test` | 0 | 24 |
| `bash scripts/backup/scan-inputs.sh` | 0 | 7 |
| `bash scripts/ci/secrets.sh` | 0 | 2 |
| `pnpm exec eslint scripts/backup` | 0 | 2 |
| `pnpm --filter backup typecheck` | 0 | 4 |
| `pnpm exec prettier --check scripts/backup docker/backup docs/ops/backup.md docs/evidence/TASK-011` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `reports/backup/junit.xml` | 65 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `reports/backup/lcov.info` | lcov | 90.32% (min 80) | 76.09% (min 75) | 88.64% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/container.sarif` | Trivy | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-011/backup-run.txt`: 3274 bytes
