# Submit check: PASS

- Commit: `50287f3fa6698dac5fedeb6aa5fb6280564eb368` on `feature/AIU-172-task-090-campaigns-history-drafts-search-and-filters-delete-screen-005`
- Base: `origin/dev` at `d98a09c1a8708976ee066d55bdfd330f5171abd8`
- Run at: 2026-11-17 06:58 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `REPORT_DIR=reports/fe-screen-005 pnpm --filter @shroomap/web lint` | 0 | 3 |
| `REPORT_DIR=reports/fe-screen-005 pnpm --filter @shroomap/web typecheck` | 0 | 8 |
| `REPORT_DIR=reports/fe-screen-005 pnpm --filter @shroomap/web test` | 0 | 24 |
| `pnpm --filter @shroomap/ui test` | 0 | 24 |
| `cd apps/web && pnpm exec playwright test --project=chromium --grep @TASK-090` | 0 | 41 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-005/junit.xml` | 365 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-005/e2e-junit.xml` | 25 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-005/lcov.info` | lcov | 90.43% (min 75) | 84.65% (min 70) | 84.91% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-090/screenshots/`: 892 bytes
