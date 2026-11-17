# Submit check: FAIL

- Commit: `b0677f041a8aa5a746314fa36ef587904a172b9b` on `feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume`
- Base: `origin/dev` at `2e5dd95ddab2ff335eb6d0f9a510d9289dc09d38`
- Run at: 2026-11-17 17:06 UTC

## Problems

- `cd apps/web && REPORT_DIR=reports/flow-01 pnpm exec playwright test --config tests/e2e/flow-01/playwright.config.ts --project=chromium` exited 1.
- `scripts/ci/deps.sh` exited 1.
- `scripts/ci/secrets.sh` exited 1.
- Test report `apps/web/reports/flow-01/e2e-junit.xml` ran no tests (0 skipped): a runner that runs nothing proves nothing.
- Scanner report `reports/deps.sarif` has 1 blocking finding(s) at High or above, e.g. High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume/pnpm-lock.yaml`.
- Secret scan `reports/secrets.sarif` has 1 blocking secret finding(s), e.g. `openai-key-shaped` at `apps/web/tests/e2e/flow-01/stack.ts:21`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 3 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 4 |
| `REPORT_DIR=reports/flow-01 pnpm --filter @shroomap/web test` | 0 | 36 |
| `cd apps/web && REPORT_DIR=reports/flow-01 pnpm exec playwright test --config tests/e2e/flow-01/playwright.config.ts --project=chromium` | 1 | 15 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 3 |
| `scripts/ci/sast.sh` | 0 | 22 |
| `scripts/ci/deps.sh` | 1 | 4 |
| `scripts/ci/secrets.sh` | 1 | 1 |

### `cd apps/web && REPORT_DIR=reports/flow-01 pnpm exec playwright test --config tests/e2e/flow-01/playwright.config.ts --project=chromium` (last 30 lines)

```
[WebServer] ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
[WebServer] 
[WebServer]   To migrate automatically, run:
[WebServer]   npx @next/codemod@canary middleware-to-proxy .
[WebServer] 
[WebServer]   Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
[WebServer] ⚠ "next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.
First argument must use the object destructuring pattern: _fixtures

   at flow-01.spec.ts:77

  75 |       session = await signIn(context, page, baseURL!);
  76 |     });
> 77 |     test.afterEach(async (_fixtures, info) => {
     |          ^
  78 |       if (info.status === info.expectedStatus) return;
  79 |       // What the api and the worker left behind, attached to the failure report.
  80 |       const jobs = await sql(
First argument must use the object destructuring pattern: _fixtures

   at flow-01.spec.ts:77

  75 |       session = await signIn(context, page, baseURL!);
  76 |     });
> 77 |     test.afterEach(async (_fixtures, info) => {
     |          ^
  78 |       if (info.status === info.expectedStatus) return;
  79 |       // What the api and the worker left behind, attached to the failure report.
  80 |       const jobs = await sql(
```

### `scripts/ci/deps.sh` (last 30 lines)

```
tools ready in /tmp/paperclip-ai-49d7702a-17ba-48f6-936a-6f2503a0a47e-f88f0cdf-1db8-45da-b8f4-6bad673cc19a-dmATMW/.cache/shroomap-ci-tools
Starting filesystem walk for root: /
Scanned /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume/pnpm-lock.yaml file and found 788 packages
End status: 0 dirs visited, 1 inodes visited, 1 Extract calls, 21.10862ms elapsed, 21.10869ms wall time
BLOCKING HIGH CVE-2026-112366 at file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume/pnpm-lock.yaml (osv-scanner)
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium CVE-2026-118764 owner=DevOps Engineer due=2026-12-17
RESULT FAIL: 1 blocking, 2 recorded, 0 dismissed, 0 tool failures
recorded medium GHSA-67mh-4wv8-2f99 owner=DevOps Engineer due=2026-12-17
recorded medium GHSA-g3hv-75wg-m249 owner=DevOps Engineer due=2026-12-17
RESULT PASS: 0 blocking, 2 recorded, 0 dismissed, 0 tool failures
```

### `scripts/ci/secrets.sh` (last 30 lines)

```
tools ready in /tmp/paperclip-ai-49d7702a-17ba-48f6-936a-6f2503a0a47e-f88f0cdf-1db8-45da-b8f4-6bad673cc19a-dmATMW/.cache/shroomap-ci-tools
[90m5:06PM[0m [32mINF[0m [1m1 commits scanned.[0m
[90m5:06PM[0m [32mINF[0m [1mscanned ~59365 bytes (59.37 KB) in 352ms[0m
[90m5:06PM[0m [33mWRN[0m [1mleaks found: 1[0m
BLOCKING HIGH openai-key-shaped at apps/web/tests/e2e/flow-01/stack.ts (gitleaks)
RESULT FAIL: 1 blocking, 0 recorded, 0 dismissed, 0 tool failures
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-01/junit.xml` | 434 | 0 | 0 | pass |
| `apps/web/reports/flow-01/e2e-junit.xml` | 0 | 0 | 0 | FAIL |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-01/lcov.info` | lcov | 91.13% (min 75) | 84.87% (min 70) | 85.26% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |

### Blocking in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume/pnpm-lock.yaml`

### Blocking in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `apps/web/tests/e2e/flow-01/stack.ts:21`

## Evidence in the commit

- `docs/evidence/TASK-104/screenshots/`: 2321 bytes
