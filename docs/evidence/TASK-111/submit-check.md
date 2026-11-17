# Submit check: FAIL

- Commit: `59d9723aa25103d2fb40f6ac1bdd7ea333caa908` on `feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route`
- Base: `origin/dev` at `37f8a0fca774baa94fa559f05a3d2ed24779ff0f`
- Run at: 2026-11-17 16:53 UTC

## Problems

- Not rebased: `origin/dev` has 6 commit(s) this branch lacks. Rebase, then rerun.
- `scripts/ci/deps.sh` exited 1.
- `scripts/ci/secrets.sh` exited 1.
- Scanner report `reports/deps.sarif` has 1 blocking finding(s) at High or above, e.g. High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml`.
- Secret scan `reports/secrets.sarif` has 5 blocking secret finding(s), e.g. `openai-key-shaped` at `docs/evidence/TASK-111/submit-check.md:3`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/flow-10 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 35 |
| `cd apps/web && REPORT_DIR=reports/flow-10 WEB_PORT=3611 E2E_PROD_PORT=3612 E2E_API_PORT=4611 E2E_DATABASE_URL=postgres://app_api@test-db:5432/task111_flow10 pnpm exec playwright test --config tests/e2e/flow-10/playwright.config.ts --project=chromium` | 0 | 25 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 4 |
| `scripts/ci/sast.sh` | 0 | 7 |
| `scripts/ci/deps.sh` | 1 | 2 |
| `scripts/ci/secrets.sh` | 1 | 1 |

### `scripts/ci/deps.sh` (last 30 lines)

```
Starting filesystem walk for root: /
Scanned /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml file and found 788 packages
End status: 0 dirs visited, 1 inodes visited, 1 Extract calls, 16.834351ms elapsed, 16.834431ms wall time
BLOCKING HIGH CVE-2026-112366 at file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml (osv-scanner)
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium CVE-2026-118764 owner=DevOps Engineer due=2026-12-17
RESULT FAIL: 1 blocking, 2 recorded, 0 dismissed, 0 tool failures
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium GHSA-g3hv-75wg-m249 owner=DevOps Engineer due=2026-12-17
RESULT PASS: 0 blocking, 2 recorded, 0 dismissed, 0 tool failures
```

### `scripts/ci/secrets.sh` (last 30 lines)

```
[90m4:53PM[0m [32mINF[0m [1m2 commits scanned.[0m
[90m4:53PM[0m [32mINF[0m [1mscanned ~15148 bytes (15.15 KB) in 364ms[0m
[90m4:53PM[0m [33mWRN[0m [1mleaks found: 5[0m
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-111/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-111/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-111/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-111/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-111/submit-check.md (gitleaks)
RESULT FAIL: 5 blocking, 0 recorded, 0 dismissed, 0 tool failures
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-10/junit.xml` | 422 | 0 | 0 | pass |
| `apps/web/reports/flow-10/e2e-junit.xml` | 8 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-10/lcov.info` | lcov | 91.01% (min 75) | 84.75% (min 70) | 85.15% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 5 | 0 | 0 | 0 | 5 | 0 |

### Blocking in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-156-task-111-flow-flow-10-end-to-end-not-found-and-home-route/pnpm-lock.yaml`

### Blocking in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `docs/evidence/TASK-111/submit-check.md:3`
- Secret `openai-key-shaped` at `docs/evidence/TASK-111/submit-check.md:11`
- Secret `openai-key-shaped` at `docs/evidence/TASK-111/submit-check.md:28`
- Secret `openai-key-shaped` at `docs/evidence/TASK-111/submit-check.md:30`
- Secret `openai-key-shaped` at `docs/evidence/TASK-111/submit-check.md:62`

## Evidence in the commit

- `docs/evidence/TASK-111/screenshots/`: 597 bytes
