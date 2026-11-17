# Submit check: FAIL

- Commit: `75e52aa923b07b67345d0083877aefdfbdbe2e3f` on `feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume`
- Base: `origin/dev` at `bdd4d50c569f40f5e403dfb6d99844658efb996b`
- Run at: 2026-11-17 20:53 UTC

## Problems

- Not rebased: `origin/dev` has 13 commit(s) this branch lacks. Rebase, then rerun.
- `scripts/ci/secrets.sh` exited 1.
- Secret scan `reports/secrets.sarif` has 1 blocking secret finding(s), e.g. `openai-key-shaped` at `docs/evidence/TASK-104/submit-check.md:3`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 4 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 4 |
| `REPORT_DIR=reports/flow-01 pnpm --filter @shroomap/web test` | 0 | 58 |
| `cd apps/web && REPORT_DIR=reports/flow-01 pnpm exec playwright test --config tests/e2e/flow-01/playwright.config.ts --project=chromium` | 0 | 165 |
| `scripts/ci/token-lint.sh` | 0 | 3 |
| `scripts/ci/layers.sh` | 0 | 5 |
| `scripts/ci/sast.sh` | 0 | 17 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 1 | 1 |

### `scripts/ci/secrets.sh` (last 30 lines)

```
[90m8:53PM[0m [32mINF[0m [1m4 commits scanned.[0m
[90m8:53PM[0m [32mINF[0m [1mscanned ~75092 bytes (75.09 KB) in 431ms[0m
[90m8:53PM[0m [33mWRN[0m [1mleaks found: 1[0m
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-104/submit-check.md (gitleaks)
RESULT FAIL: 1 blocking, 0 recorded, 0 dismissed, 0 tool failures
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-01/junit.xml` | 439 | 0 | 0 | pass |
| `apps/web/reports/flow-01/e2e-junit.xml` | 23 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-01/lcov.info` | lcov | 90.60% (min 75) | 84.86% (min 70) | 85.31% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby; verified with pnpm why, devDependencies only) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-096 check passed; the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

### Blocking in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `docs/evidence/TASK-104/submit-check.md:3`

## Evidence in the commit

- `docs/evidence/TASK-104/screenshots/`: 2321 bytes
