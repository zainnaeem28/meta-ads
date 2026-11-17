# Submit check: PASS

- Commit: `3d29a0f756aed6976750aed188bb7fde4be0617e` on `TASK-110 branch`
- Base: `origin/dev` at `8c084b79ae792bb9a8a737e0ed82b405f3f8d9fa`
- Run at: 2026-11-17 20:28 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/flow-07 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 53 |
| `cd apps/web && REPORT_DIR=reports/flow-07 WEB_PORT=3710 E2E_PROD_PORT=3711 E2E_API_PORT=4710 E2E_DATABASE_URL=postgres://app_api@test-db:5432/task110_flow07 pnpm exec playwright test --config tests/e2e/flow-07/playwright.config.ts --project=chromium` | 0 | 52 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 5 |
| `scripts/ci/sast.sh` | 0 | 8 |
| `scripts/ci/deps.sh || true` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-07/junit.xml` | 439 | 0 | 0 | pass |
| `apps/web/reports/flow-07/e2e-junit.xml` | 13 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-07/lcov.info` | lcov | 90.60% (min 75) | 84.86% (min 70) | 85.31% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/TASK-110 branch/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-110/screenshots/`: 1126 bytes
