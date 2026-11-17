# Submit check: FAIL

- Commit: `bd9d25a16a59db0271ac83f791ce018c7f99f2c9` on `feature/AIU-127-task-065-api-conformance-authorization-matrix-and-zero-trust-suites-on-the-running-app`
- Base: `origin/dev` at `2e5dd95ddab2ff335eb6d0f9a510d9289dc09d38`
- Run at: 2026-11-17 17:20 UTC

## Problems

- `scripts/ci/deps.sh` exited 1.
- `scripts/ci/secrets.sh` exited 1.
- Scanner report `reports/deps.json` has 2 blocking finding(s) at High or above, e.g. High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-127-task-065-api-conformance-authorization-matrix-and-zero-trust-suites-on-the-running-app/pnpm-lock.yaml`.
- Secret scan `reports/secrets.sarif` has 1 blocking secret finding(s), e.g. `openai-key-shaped` at `apps/api/tests/conformance/zero-trust.conformance.test.ts:154`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api test:conformance` | 0 | 355 |
| `scripts/ci/sast.sh` | 0 | 53 |
| `scripts/ci/deps.sh` | 1 | 5 |
| `scripts/ci/secrets.sh` | 1 | 6 |
| `python3 -I -c "import json,glob;m=[];[m.extend(json.load(open(f))[k]) for f in glob.glob('reports/findings/deps*.json') for k in ('blocking','nonBlocking')];json.dump({'findings':m},open('reports/deps.json','w'))"` | 0 | 0 |

### `scripts/ci/deps.sh` (last 30 lines)

```
tools ready in /tmp/paperclip-ai-49d7702a-17ba-48f6-936a-6f2503a0a47e-f88f0cdf-1db8-45da-b8f4-6bad673cc19a-axl049/.cache/shroomap-ci-tools
Starting filesystem walk for root: /
Scanned /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-127-task-065-api-conformance-authorization-matrix-and-zero-trust-suites-on-the-running-app/pnpm-lock.yaml file and found 788 packages
End status: 0 dirs visited, 1 inodes visited, 1 Extract calls, 49.448256ms elapsed, 49.448316ms wall time
BLOCKING HIGH CVE-2026-112366 at file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-127-task-065-api-conformance-authorization-matrix-and-zero-trust-suites-on-the-running-app/pnpm-lock.yaml (osv-scanner)
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium CVE-2026-118764 owner=DevOps Engineer due=2026-12-17
RESULT FAIL: 1 blocking, 2 recorded, 0 dismissed, 0 tool failures
BLOCKING HIGH GHSA-fc5q-39xc-vjpf at picomatch (audit)
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium GHSA-g3hv-75wg-m249 owner=DevOps Engineer due=2026-12-17
RESULT FAIL: 1 blocking, 2 recorded, 0 dismissed, 0 tool failures
```

### `scripts/ci/secrets.sh` (last 30 lines)

```
tools ready in /tmp/paperclip-ai-49d7702a-17ba-48f6-936a-6f2503a0a47e-f88f0cdf-1db8-45da-b8f4-6bad673cc19a-axl049/.cache/shroomap-ci-tools
[90m5:20PM[0m [32mINF[0m [1m8 commits scanned.[0m
[90m5:20PM[0m [32mINF[0m [1mscanned ~157843 bytes (157.84 KB) in 1s[0m
[90m5:20PM[0m [33mWRN[0m [1mleaks found: 1[0m
BLOCKING HIGH openai-key-shaped at apps/api/tests/conformance/zero-trust.conformance.test.ts (gitleaks)
RESULT FAIL: 1 blocking, 0 recorded, 0 dismissed, 0 tool failures
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/api/reports/conformance/junit.xml` | 628 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/api/reports/conformance/lcov.info` | lcov | 99.67% (min 80) | 88.54% (min 75) | 98.70% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.json` | finding list | 0 | 2 | 4 | 0 | 0 | 0 | 2 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |

### Blocking in `reports/deps.json`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-127-task-065-api-conformance-authorization-matrix-and-zero-trust-suites-on-the-running-app/pnpm-lock.yaml`
- High `GHSA-fc5q-39xc-vjpf` at `picomatch`

### Blocking in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `apps/api/tests/conformance/zero-trust.conformance.test.ts:154`

## Evidence in the commit

- `docs/evidence/TASK-065/submit-check.md`: 52 bytes
