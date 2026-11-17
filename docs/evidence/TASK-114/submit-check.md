# Submit check: FAIL

- Commit: `cac34097d8197ae37b7c2aecde9126c799ae6617` on `feature/AIU-181-task-114-flow-flow-13-end-to-end-admin-usage-report`
- Base: `origin/dev` at `fe05821950fb40fac2a7f2741a04f41914e7c9fd`
- Run at: 2026-11-17 16:39 UTC

## Problems

- `scripts/ci/deps.sh` exited 1.
- Scanner report `reports/deps.sarif` has 1 blocking finding(s) at High or above, e.g. High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-181-task-114-flow-flow-13-end-to-end-admin-usage-report/pnpm-lock.yaml`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 6 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 4 |
| `REPORT_DIR=reports/flow-13 pnpm --filter @shroomap/web test` | 0 | 48 |
| `cd apps/web && EVIDENCE_DIR=../../docs/evidence/TASK-114 pnpm exec playwright test -c tests/e2e/flow-13/playwright.config.ts --project=chromium` | 0 | 66 |
| `scripts/ci/token-lint.sh` | 0 | 5 |
| `scripts/ci/layers.sh` | 0 | 6 |
| `scripts/ci/sast.sh` | 0 | 17 |
| `scripts/ci/deps.sh` | 1 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

### `scripts/ci/deps.sh` (last 30 lines)

```
Starting filesystem walk for root: /
Scanned /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-181-task-114-flow-flow-13-end-to-end-admin-usage-report/pnpm-lock.yaml file and found 788 packages
End status: 0 dirs visited, 1 inodes visited, 1 Extract calls, 31.780263ms elapsed, 31.780393ms wall time
BLOCKING HIGH CVE-2026-112366 at file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-181-task-114-flow-flow-13-end-to-end-admin-usage-report/pnpm-lock.yaml (osv-scanner)
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
| `apps/web/reports/flow-13/junit.xml` | 422 | 0 | 0 | pass |
| `apps/web/reports/flow-13/e2e-junit.xml` | 12 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-13/lcov.info` | lcov | 91.01% (min 75) | 84.75% (min 70) | 85.15% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Blocking in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-181-task-114-flow-flow-13-end-to-end-admin-usage-report/pnpm-lock.yaml`

## Evidence in the commit

- `docs/evidence/TASK-114/screenshots/`: 733 bytes
