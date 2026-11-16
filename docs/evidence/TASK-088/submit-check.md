# Submit check: PASS

- Commit: `166a02fd232023189240da8235a47dd4ab552d79` on `feature/AIU-153-task-088-access-states-not-linked-request-pending-suspended-removed-invite-invalid-screen-002`
- Base: `origin/dev` at `68dc1c467a04ac7b2be44fc6d2ce6b1c55712b3f`
- Run at: 2026-11-16 17:25 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 29 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && REPORT_DIR=reports/fe-screen-002 pnpm --filter @shroomap/web test` | 0 | 22 |
| `pnpm --filter @shroomap/ui test` | 0 | 31 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/fe-screen-002/e2e-junit.xml REPORT_DIR=reports/fe-screen-002 WEB_PORT=3158 E2E_API_PORT=4158 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu152_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-088 --reporter=junit` | 0 | 51 |
| `scripts/ci/token-lint.sh` | 0 | 2 |
| `scripts/ci/layers.sh` | 0 | 4 |
| `scripts/ci/sast.sh` | 0 | 18 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-002/junit.xml` | 227 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-002/e2e-junit.xml` | 18 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-002/lcov.info` | lcov | 95.72% (min 75) | 92.23% (min 70) | 89.02% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-088/screenshots/`: 475 bytes
