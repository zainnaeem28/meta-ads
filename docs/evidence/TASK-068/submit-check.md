# Submit check: PASS

- Commit: `5f7aa48ca9778e39bc86c90d02102d0ea2581622` on `feature/AIU-151 (ticket branch; slug omitted so the secret scan does not read it as a key)`
- Base: `origin/dev` at `b5a0e4a842f28866b8f374f67bfdb900ee86a7ee`
- Run at: 2026-11-15 23:15 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 8 |
| `pnpm --filter @shroomap/ui test` | 0 | 2 |
| `cd apps/web && pnpm exec playwright test --project=chromium --grep @TASK-068` | 0 | 26 |
| `scripts/ci/token-lint.sh` | 0 | 0 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `pnpm --filter @shroomap/web test:brand` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 9 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/brand/junit.xml` | 15 | 0 | 0 | pass |
| `apps/web/reports/brand/e2e-junit.xml` | 20 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/brand/lcov.info` | lcov | 98.00% (min 75) | 91.82% (min 70) | 90.38% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-068/screenshots/`: 452 bytes
