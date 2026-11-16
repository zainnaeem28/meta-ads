# Submit check: PASS

- Commit: `6d67708885f79255c1f7dd6a7bace7ad9e1b620d` on `feature/AIU-157-task-087-auth-screens-sign-in-and-two-step-verification-provider-hosted-and-themed-screen-001-003`
- Base: `origin/dev` at `8917eb8474ca0672c72cd1cd2fd5a4f79c576437`
- Run at: 2026-11-16 15:20 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 28 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && REPORT_DIR=reports/fe-screen-001-003 pnpm --filter @shroomap/web test` | 0 | 19 |
| `pnpm --filter @shroomap/ui test` | 0 | 41 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/fe-screen-001-003/e2e-junit.xml REPORT_DIR=reports/fe-screen-001-003 WEB_PORT=3157 E2E_API_PORT=4157 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu152_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-087 --reporter=junit` | 0 | 50 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 3 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-001-003/junit.xml` | 170 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-001-003/e2e-junit.xml` | 7 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-001-003/lcov.info` | lcov | 94.62% (min 75) | 91.04% (min 70) | 88.95% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-087/screenshots/`: 602 bytes
