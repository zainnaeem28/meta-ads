# Submit check: PASS

- Commit: `dfc8210f131d4fc06d7b1ae0509bc8f8e7136039` on `feature/AIU-155-task-089-not-found-and-unavailable-record-home-route-screen-004`
- Base: `origin/dev` at `7c0333e72aa3ad74d63b202ecc2b99a1b4ebd39c`
- Run at: 2026-11-16 15:31 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint typecheck test; pnpm --filter @shroomap/ui test; pnpm exec playwright test --project=chromium --grep @TASK-089; scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 36 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-004/junit.xml` | 169 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-004/e2e-junit.xml` | 7 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-004/lcov.info` | lcov | 93.93% (min 75) | 91.60% (min 70) | 88.82% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-089/screenshots/`: 186 bytes
