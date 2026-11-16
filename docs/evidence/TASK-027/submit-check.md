# Submit check: PASS

- Commit: `a8200aaf4bbd2f25209350e368603569b45ee09d` on the ticket branch
- Base: `origin/dev` at `fa758bf08ab4456dd02aaaa60e92a2cfdf059c4e`
- Run at: 2026-11-15 23:59 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api lint typecheck test:unit test:integration; scripts/ci/layers.sh; scripts/ci/contract.sh` | 0 | 14 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/api/reports/limits/junit.xml` | 403 | 0 | 9 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/api/reports/limits/lcov.info` | lcov | 98.47% (min 90) | 94.37% (min 85) | 96.09% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-027/submit-check.md`: 53 bytes
