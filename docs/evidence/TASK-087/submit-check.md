# Submit check: PASS

- Commit: `1f13df7275ef106283c86b89e9d11d5aaf3218be` on `feature/AIU-157-task-087-auth-screens-sign-in-and-two-step-verification-provider-hosted-and-themed-screen-001-003`
- Base: `origin/dev` at `7c0333e72aa3ad74d63b202ecc2b99a1b4ebd39c`
- Run at: 2026-11-16 15:43 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 21 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && REPORT_DIR=reports/fe-screen-001-003 pnpm --filter @shroomap/web test` | 0 | 17 |
| `pnpm --filter @shroomap/ui test` | 0 | 32 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/fe-screen-001-003/e2e-junit.xml REPORT_DIR=reports/fe-screen-001-003 WEB_PORT=3157 E2E_API_PORT=4157 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu152_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-087 --reporter=junit` | 0 | 25 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-001-003/junit.xml` | 172 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-001-003/e2e-junit.xml` | 7 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-001-003/lcov.info` | lcov | 94.64% (min 75) | 91.15% (min 70) | 88.95% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-087/screenshots/`: 602 bytes
