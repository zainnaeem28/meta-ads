# Submit check: FAIL

- Commit: `69c17fedd8692e44fc706eabd048f8159ec4aed0` on `feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route`
- Base: `origin/dev` at `fdb88613359ed6f56f261f715a455b0d169a0059`
- Run at: 2026-11-17 16:51 UTC

## Problems

- `scripts/ci/deps.sh` exited 1.
- Test report `apps/web/reports/flow-10/e2e-junit.xml` is missing: the check that should write it did not.
- Scanner report `reports/deps.sarif` has 1 blocking finding(s) at High or above, e.g. High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/flow-10 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 48 |
| `cd apps/web && REPORT_DIR=reports/flow-10 WEB_PORT=3611 E2E_PROD_PORT=3612 E2E_API_PORT=4611 E2E_DATABASE_URL=postgres://app_api@test-db:5432/task111_flow10 pnpm exec playwright test --config tests/e2e/flow-10/playwright.config.ts --project=chromium` | 0 | 33 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 6 |
| `scripts/ci/sast.sh` | 0 | 13 |
| `scripts/ci/deps.sh` | 1 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

### `scripts/ci/deps.sh` (last 30 lines)

```
Starting filesystem walk for root: /
Scanned /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml file and found 788 packages
End status: 0 dirs visited, 1 inodes visited, 1 Extract calls, 43.351264ms elapsed, 43.351374ms wall time
BLOCKING HIGH CVE-2026-112366 at file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml (osv-scanner)
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium CVE-2026-118764 owner=DevOps Engineer due=2026-12-17
RESULT FAIL: 1 blocking, 2 recorded, 0 dismissed, 0 tool failures
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium GHSA-g3hv-75wg-m249 owner=DevOps Engineer due=2026-12-17
RESULT PASS: 0 blocking, 2 recorded, 0 dismissed, 0 tool failures
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-10/junit.xml` | 422 | 0 | 0 | pass |
| `apps/web/reports/flow-10/e2e-junit.xml` | - | - | - | is missing: the check that should write it did not |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-10/lcov.info` | lcov | 91.01% (min 75) | 84.75% (min 70) | 85.15% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Blocking in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml`

## Evidence in the commit

- `docs/evidence/TASK-111/screenshots/`: 597 bytes
