# Submit check: PASS

- Commit: `a7a47a59647cdbfe8a78ac63f73923c451a7b6cd` on `feature/AIU-153-task-088-access-states-not-linked-request-pending-suspended-removed-invite-invalid-screen-002`
- Base: `origin/dev` at `039286dfd0500f5edf8b80130d1e846efe16f7ce`
- Run at: 2026-11-16 16:52 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 20 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && REPORT_DIR=reports/fe-screen-002 pnpm --filter @shroomap/web test` | 0 | 18 |
| `pnpm --filter @shroomap/ui test` | 0 | 34 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/fe-screen-002/e2e-junit.xml REPORT_DIR=reports/fe-screen-002 WEB_PORT=3158 E2E_API_PORT=4158 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu152_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-088 --reporter=junit` | 0 | 34 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 10 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-002/junit.xml` | 203 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-002/e2e-junit.xml` | 18 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-002/lcov.info` | lcov | 94.98% (min 75) | 90.69% (min 70) | 88.48% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-088/screenshots/`: 475 bytes
