# Submit check: PASS

- Commit: `c57c846645b8a81af7925d280364c61ba236067c` on `feature/AIU-182-task-102-admin-alerts-list-and-acknowledge-screen-014`
- Base: `origin/dev` at `cd7f024081ed7bc356e6702b2cb6c2e682c441b6`
- Run at: 2026-11-16 15:56 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 2 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 3 |
| `pnpm --filter @shroomap/web test` | 0 | 9 |
| `pnpm --filter @shroomap/ui test` | 0 | 24 |
| `cd apps/web && pnpm exec playwright test --project=chromium --grep @TASK-102` | 0 | 24 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 12 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-014/junit.xml` | 180 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-014/e2e-junit.xml` | 16 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-014/lcov.info` | lcov | 93.99% (min 75) | 90.19% (min 70) | 88.38% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-102/screenshots/`: 529 bytes
