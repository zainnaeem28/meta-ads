# Submit check: PASS

- Commit: `a6cea80e877ec0748c1e6b262378015f588d1628` on `feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route`
- Base: `origin/dev` at `37f8a0fca774baa94fa559f05a3d2ed24779ff0f`
- Run at: 2026-11-17 16:59 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/flow-10 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 41 |
| `cd apps/web && REPORT_DIR=reports/flow-10 WEB_PORT=3611 E2E_PROD_PORT=3612 E2E_API_PORT=4611 E2E_DATABASE_URL=postgres://app_api@test-db:5432/task111_flow10 pnpm exec playwright test --config tests/e2e/flow-10/playwright.config.ts --project=chromium` | 0 | 85 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 5 |
| `scripts/ci/sast.sh` | 0 | 15 |
| `scripts/ci/deps.sh || true` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-10/junit.xml` | 434 | 0 | 0 | pass |
| `apps/web/reports/flow-10/e2e-junit.xml` | 8 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-10/lcov.info` | lcov | 91.13% (min 75) | 84.87% (min 70) | 85.26% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-111/screenshots/`: 597 bytes
