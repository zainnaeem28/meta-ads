# Submit check: FAIL

- Commit: `75d06108da794dd2c888ed98ee27917838a42d9e` on `bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-`
- Base: `origin/dev` at `9759e129ff3a2232b96a71c1b835e27c7556b42b`
- Run at: 2026-11-17 17:58 UTC

## Problems

- `scripts/ci/lint.sh` exited 1.
- `scripts/ci/deps.sh` exited 1.
- `scripts/ci/probes/run-all.sh` exited 1.
- Scanner report `reports/deps.sarif` has 1 blocking finding(s) at High or above, e.g. High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/pnpm-lock.yaml`.
- Scanner report `reports/audit.json` has 1 blocking finding(s) at High or above, e.g. High `GHSA-fc5q-39xc-vjpf` at `picomatch`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `scripts/ci/lint.sh` | 1 | 86 |
| `scripts/ci/types.sh` | 0 | 274 |
| `scripts/ci/layers.sh` | 0 | 11 |
| `scripts/ci/unit.sh ci` | 0 | 33 |
| `scripts/ci/contract.sh` | 0 | 23 |
| `scripts/ci/sast.sh` | 0 | 95 |
| `scripts/ci/deps.sh` | 1 | 11 |
| `scripts/ci/secrets.sh` | 0 | 4 |
| `scripts/ci/probes/run-all.sh` | 1 | 69 |

### `scripts/ci/lint.sh` (last 30 lines)

```
  13:5    error  The value assigned to 'status' is not used in subsequent statements  no-useless-assignment
  19:104  error  'process' is not defined                                             no-undef
  24:12   error  'process' is not defined                                             no-undef
  28:19   error  'process' is not defined                                             no-undef
  29:23   error  'process' is not defined                                             no-undef
  38:1    error  'process' is not defined                                             no-undef

/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/docs/evidence/TASK-097/e2e-with-database.mjs
  13:5    error  The value assigned to 'status' is not used in subsequent statements  no-useless-assignment
  19:104  error  'process' is not defined                                             no-undef
  24:12   error  'process' is not defined                                             no-undef
  28:19   error  'process' is not defined                                             no-undef
  29:23   error  'process' is not defined                                             no-undef
  38:1    error  'process' is not defined                                             no-undef

/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/packages/ui/src/components/cmp-021/FileUpload.tsx
  153:19  error  Definition for rule '@next/next/no-img-element' was not found  @next/next/no-img-element

/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/packages/ui/src/components/cmp-024/SegmentEditor.test.tsx
  2:40  error  'waitFor' is defined but never used  @typescript-eslint/no-unused-vars

/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/packages/ui/src/components/cmp-027/CampaignRow.tsx
  84:11  error  Definition for rule '@next/next/no-img-element' was not found  @next/next/no-img-element

/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/scripts/ci/release-tests/test/observe.test.ts
  130:23  error  '_gone' is assigned a value but never used  @typescript-eslint/no-unused-vars

✖ 53 problems (53 errors, 0 warnings)

 ELIFECYCLE  Command failed with exit code 1.
```

### `scripts/ci/deps.sh` (last 30 lines)

```
tools ready in /tmp/paperclip-ai-49d7702a-17ba-48f6-936a-6f2503a0a47e-f88f0cdf-1db8-45da-b8f4-6bad673cc19a-ihQT8D/.cache/shroomap-ci-tools
Starting filesystem walk for root: /
Scanned /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/pnpm-lock.yaml file and found 788 packages
End status: 0 dirs visited, 1 inodes visited, 1 Extract calls, 83.573589ms elapsed, 83.57384ms wall time
BLOCKING HIGH CVE-2026-112366 at file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/pnpm-lock.yaml (osv-scanner)
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium CVE-2026-118764 owner=DevOps Engineer due=2026-12-17
RESULT FAIL: 1 blocking, 2 recorded, 0 dismissed, 0 tool failures
BLOCKING HIGH GHSA-fc5q-39xc-vjpf at picomatch (audit)
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium GHSA-g3hv-75wg-m249 owner=DevOps Engineer due=2026-12-17
RESULT FAIL: 1 blocking, 2 recorded, 0 dismissed, 0 tool failures
```

### `scripts/ci/probes/run-all.sh` (last 30 lines)

```
      PASS unit-ci      3 tests ran, 0 skipped; coverage lines 100.0%, branches 100.0%
      FAIL contract     stub run but packages/contracts/openapi.yaml exists, so the real check is required
      PASS sast         1 recorded, 0 dismissed
      PASS deps         0 recorded, 0 dismissed
      PASS deps-audit   0 recorded, 0 dismissed
      PASS secrets      0 recorded, 0 dismissed
      PASS workflow     9 jobs, all 9 required present, actions pinned
      QUALITY GATE FAIL (profile ticket, commit 75d06108da79)
      recorded: PROBE-MED-1 owner=DevOps Engineer due=2026-12-17
PASS  4b nonblocking finding is recorded with owner and due date
PASS  4c a leaked secret                                         gate exit 1: FAIL secrets      BLOCKING HIGH probe-secret-1 at example.env (probe-scanner)
PASS  4d a secret cannot be dismissed by a disposition           gate exit 1: FAIL secrets      BLOCKING HIGH probe-secret-1 at example.env (probe-scanner)
PASS  5a report for the wrong commit                             gate exit 1: FAIL unit-ci      report is for commit 000000000000, expected 75d06108da79 (wrong commit)
PASS  5b report older than the commit (stale)                    gate exit 1: FAIL sast         report file 'sast.sarif' is older than commit 75d06108da79 (stale)
PASS  5d summary report (lint) missing                           gate exit 1: FAIL lint         report file 'lint/summary.json' is missing
PASS  5e summary report (lint) changed after its wrapper wrote it gate exit 1: FAIL lint         report file 'lint/summary.json' does not match the hash its wrapper recorded
PASS  5f summary report (types) stale                            gate exit 1: FAIL types        report file 'types/summary.json' is older than commit 75d06108da79 (stale)
PASS  5c report changed after its wrapper wrote it               gate exit 1: FAIL sast         report file 'sast.sarif' does not match the hash its wrapper recorded
PASS  6a workflow edit removes a required job                    gate exit 1: FAIL workflow     required job(s) missing: security
PASS  6b workflow edit unpins an action                          gate exit 1: FAIL workflow     unpinned action actions/checkout@v4
== layer probes (ARCHITECTURE section 1.4)
PASS  L0 clean fixture tree passes                               layers exit 0: layers: 6 modules, 0 violations
PASS  L1 upward import (production imports lifecycle)            layers exit 1: VIOLATION no-upward-module-import: apps/api/src/modules/production/application/production.service.ts -> apps/api/src/modules/lifecycle/index.ts
PASS  L2 deep import into another module's repository            layers exit 1: VIOLATION no-deep-import: apps/api/src/modules/campaigns/application/campaign.service.ts -> apps/api/src/modules/media/infrastructure/media.repository
PASS  L3 api-process file imports key-unsealer.ts                layers exit 1: VIOLATION unsealer-worker-only: apps/api/src/bootstrap/api.module.ts -> apps/api/src/modules/provider-keys/infrastructure/key-unsealer.ts
PASS  L4 cycle between two platform packages                     layers exit 1: VIOLATION no-cycles: apps/api/src/platform/config/index.ts -> apps/api/src/platform/db/index.ts
PASS  L5 apps/web imports apps/api                               layers exit 1: VIOLATION web-no-api: apps/web/src/page.ts -> apps/api/src/modules/audit/index.ts
== real tree
PASS  real tree passes layers.sh: layers: 862 modules, 0 violations
2 PROBE(S) DID NOT BEHAVE
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `reports/ci/junit.xml` | 40 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `reports/ci/lcov.info` | lcov | 97.97% (min 80) | 96.24% (min 75) | 100.00% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Blocking in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/bugfix/AIU-253-task-106-fix-worker-test-mode-only-provider-origin-override-wavespeed-openai-qc-that-stays-on-the-egress-/pnpm-lock.yaml`

### Blocking in `reports/audit.json`

- High `GHSA-fc5q-39xc-vjpf` at `picomatch`
