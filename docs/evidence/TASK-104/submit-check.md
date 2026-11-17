# Submit check: FAIL

- Commit: `be7b2939cb3b2a68d48ad56ce48c78e1db85fbc5` on `feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume`
- Base: `origin/dev` at `eea7272e0938857dca3a4ca75bb3ca0c613392ea`
- Run at: 2026-11-17 20:41 UTC

## Problems

- `REPORT_DIR=reports/flow-01 pnpm --filter @shroomap/web test` exited 1.
- `scripts/ci/secrets.sh` exited 1.
- Test report `apps/web/reports/flow-01/junit.xml` has 1 failed test(s).
- Coverage report `apps/web/reports/flow-01/lcov.info` is missing: the check that should write it did not.
- Secret scan `reports/secrets.sarif` has 5 blocking secret finding(s), e.g. `openai-key-shaped` at `docs/evidence/TASK-104/submit-check.md:3`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 5 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 10 |
| `REPORT_DIR=reports/flow-01 pnpm --filter @shroomap/web test` | 1 | 47 |
| `cd apps/web && REPORT_DIR=reports/flow-01 pnpm exec playwright test --config tests/e2e/flow-01/playwright.config.ts --project=chromium` | 0 | 162 |
| `scripts/ci/token-lint.sh` | 0 | 2 |
| `scripts/ci/layers.sh` | 0 | 3 |
| `scripts/ci/sast.sh` | 0 | 34 |
| `scripts/ci/deps.sh` | 0 | 5 |
| `scripts/ci/secrets.sh` | 1 | 2 |

### `REPORT_DIR=reports/flow-01 pnpm --filter @shroomap/web test` (last 30 lines)

```
          class="flex flex-col gap-2"
          role="alert"
        />
      </div>
    </div>
  </div>
</body>[39m
 ❯ src/features/fe-screen-006a/NewBriefWizard.test.tsx:109:79
    107|     expect(window.location.search).toBe(`?draft=${ID}`);
    108|     expect(screen.getByTestId('save-status')).toHaveTextContent('Draft…
    109|     expect(screen.getByRole('heading', { level: 2, name: COPY.step2.ti…
       |                                                                               ^
    110|   });
    111|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 42 passed (43)
      Tests  1 failed | 438 passed (439)
   Start at  20:37:19
   Duration  45.59s (tests 55%, environment 17%, import 17%, transform 5%, setup 4%, worker 2%)

    Isolate  43 workers spawned · ~691ms startup each (spawn + environment, per file)
             at least ~9.21s faster with isolate: false — reuses workers across files instead of one per file

JUNIT report written to /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume/apps/web/reports/flow-01/junit.xml
/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume/apps/web:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @shroomap/web@0.0.0 test: `NODE_ENV=test vitest run --config vitest.config.ts --coverage`
Exit status 1
```

### `scripts/ci/secrets.sh` (last 30 lines)

```
tools ready in /tmp/paperclip-ai-49d7702a-17ba-48f6-936a-6f2503a0a47e-f88f0cdf-1db8-45da-b8f4-6bad673cc19a-j1BrJm/.cache/shroomap-ci-tools
[90m8:41PM[0m [32mINF[0m [1m2 commits scanned.[0m
[90m8:41PM[0m [32mINF[0m [1mscanned ~67382 bytes (67.38 KB) in 495ms[0m
[90m8:41PM[0m [33mWRN[0m [1mleaks found: 5[0m
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-104/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-104/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-104/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-104/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-104/submit-check.md (gitleaks)
RESULT FAIL: 5 blocking, 0 recorded, 0 dismissed, 0 tool failures
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-01/junit.xml` | 439 | 1 | 0 | FAIL |
| `apps/web/reports/flow-01/e2e-junit.xml` | 23 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-01/lcov.info` | is missing: the check that should write it did not | - | - | - | - |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 5 | 0 | 0 | 0 | 5 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-177-task-104-flow-flow-01-end-to-end-enter-inputs-and-resume/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby; verified with pnpm why, devDependencies only) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-096 check passed; the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

### Blocking in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `docs/evidence/TASK-104/submit-check.md:3`
- Secret `openai-key-shaped` at `docs/evidence/TASK-104/submit-check.md:13`
- Secret `openai-key-shaped` at `docs/evidence/TASK-104/submit-check.md:69`
- Secret `openai-key-shaped` at `docs/evidence/TASK-104/submit-check.md:71`
- Secret `openai-key-shaped` at `docs/evidence/TASK-104/submit-check.md:115`

## Evidence in the commit

- `docs/evidence/TASK-104/screenshots/`: 2321 bytes
