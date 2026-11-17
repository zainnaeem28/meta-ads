# Submit check: PASS

- Commit: `e79753b8716a32e8984dd96eaad6f0827cccadd0` on `feature/AIU-185-task-099-admin-accounts-list-invite-suspend-reinstate-remove-role-erasures-screen-011`
- Base: `origin/dev` at `8ee7979601288203dff573d4877a4093641a29c9`
- Run at: 2026-11-17 08:22 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `REPORT_DIR=reports/fe-screen-011 pnpm --filter @shroomap/web lint` | 0 | 17 |
| `REPORT_DIR=reports/fe-screen-011 pnpm --filter @shroomap/web typecheck` | 0 | 11 |
| `REPORT_DIR=reports/fe-screen-011 pnpm --filter @shroomap/web test` | 0 | 80 |
| `pnpm --filter @shroomap/ui test` | 0 | 66 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/fe-screen-011/e2e-junit.xml REPORT_DIR=reports/fe-screen-011 WEB_PORT=3185 E2E_API_PORT=4185 pnpm exec playwright test --project=chromium --grep @TASK-099 --reporter=junit` | 0 | 182 |
| `scripts/ci/token-lint.sh` | 0 | 7 |
| `scripts/ci/layers.sh` | 0 | 14 |
| `scripts/ci/sast.sh` | 0 | 92 |
| `scripts/ci/deps.sh` | 0 | 7 |
| `scripts/ci/secrets.sh` | 0 | 4 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-011/junit.xml` | 382 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-011/e2e-junit.xml` | 35 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-011/lcov.info` | lcov | 90.50% (min 75) | 84.45% (min 70) | 84.25% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-099/screenshots/`: 1378 bytes
