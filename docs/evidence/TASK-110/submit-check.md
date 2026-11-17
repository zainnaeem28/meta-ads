# Submit check: FAIL

- Commit: `f459b7b33b74efc360cdaf23a45bf32e3ed08b99` on `TASK-110 branch`
- Base: `origin/dev` at `9759e129ff3a2232b96a71c1b835e27c7556b42b`
- Run at: 2026-11-17 18:14 UTC

## Problems

- `cd apps/web && REPORT_DIR=reports/flow-07 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` exited 1.
- `cd apps/web && REPORT_DIR=reports/flow-07 WEB_PORT=3710 E2E_PROD_PORT=3711 E2E_API_PORT=4710 E2E_DATABASE_URL=postgres://app_api@test-db:5432/task110_flow07 pnpm exec playwright test --config tests/e2e/flow-07/playwright.config.ts --project=chromium` exited 1.
- Test report `apps/web/reports/flow-07/junit.xml` has 1 failed test(s).
- Test report `apps/web/reports/flow-07/e2e-junit.xml` has 1 failed test(s).
- Coverage report `apps/web/reports/flow-07/lcov.info` is missing: the check that should write it did not.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/flow-07 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 1 | 72 |
| `cd apps/web && REPORT_DIR=reports/flow-07 WEB_PORT=3710 E2E_PROD_PORT=3711 E2E_API_PORT=4710 E2E_DATABASE_URL=postgres://app_api@test-db:5432/task110_flow07 pnpm exec playwright test --config tests/e2e/flow-07/playwright.config.ts --project=chromium` | 1 | 253 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 11 |
| `scripts/ci/sast.sh` | 0 | 21 |
| `scripts/ci/deps.sh || true` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

### `cd apps/web && REPORT_DIR=reports/flow-07 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` (last 30 lines)

```
          class="inline-flex items-center justify-center gap-2 rounded-md border text-ui font-medium no-underline whitespace-nowrap transition-colors duration-(--duration-fast) ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring border-transparent bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active min-h-control max-md:min-h-control-touch px-4 disabled:bg-disabled disabled:text-disabled-foreground disabled:border-border disabled:cursor-not-allowed aria-disabled:bg-disabled aria-disabled:text-disabled-foreground aria-disabled:border-border aria-disabled:cursor-not-allowed aria-busy:cursor-progress"
          data-variant="primary"
          type="button"
        >
          Sign in again
        </button>
      </div>
    </div>
  </div>
</body>[39m
 ❯ src/features/fe-screen-006a/NewBriefWizard.test.tsx:235:68
    233|     const dialog = await screen.findByRole('alertdialog', { name: COPY…
    234|     expect(dialog).toHaveTextContent('you will return to step 2 of thi…
    235|     expect(screen.getByRole('button', { name: COPY.signInAgain })).toH…
       |                                                                    ^
    236|     fireEvent.click(screen.getByRole('button', { name: COPY.signInAgai…
    237|     expect(assign).toHaveBeenCalledWith(`/sign-in?reason=session-expir…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 40 passed (41)
      Tests  1 failed | 433 passed (434)
   Start at  18:08:30
   Duration  69.21s (tests 54%, environment 19%, import 18%, setup 4%, transform 3%, worker 2%)

    Isolate  41 workers spawned · ~1.16s startup each (spawn + environment, per file)
             at least ~14.67s faster with isolate: false — reuses workers across files instead of one per file

JUNIT report written to /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/TASK-110 branch/apps/web/reports/flow-07/junit.xml
```

### `cd apps/web && REPORT_DIR=reports/flow-07 WEB_PORT=3710 E2E_PROD_PORT=3711 E2E_API_PORT=4710 E2E_DATABASE_URL=postgres://app_api@test-db:5432/task110_flow07 pnpm exec playwright test --config tests/e2e/flow-07/playwright.config.ts --project=chromium` (last 30 lines)

```
    Error: frame.evaluate: Test timeout of 120000ms exceeded.

       at ../../support/axe.ts:13

      11 |   let builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
      12 |   if (include) builder = builder.include(include);
    > 13 |   const { violations } = await builder.analyze();
         |                          ^
      14 |   if (reportPath) {
      15 |     mkdirSync(dirname(reportPath), { recursive: true });
      16 |     writeFileSync(reportPath, JSON.stringify(violations, null, 2));
        at AxeBuilder.runPartialRecursive (/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/TASK-110 branch/node_modules/.pnpm/@axe-core+playwright@4.10.2_playwright-core@1.65.1/node_modules/@axe-core/playwright/dist/index.js:318:34)
        at AxeBuilder.analyze (/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/TASK-110 branch/node_modules/.pnpm/@axe-core+playwright@4.10.2_playwright-core@1.65.1/node_modules/@axe-core/playwright/dist/index.js:245:28)
        at expectNoAxeViolations (/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/TASK-110 branch/apps/web/tests/support/axe.ts:13:26)
        at capture (/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/TASK-110 branch/apps/web/tests/e2e/flow-07/flow-07.spec.ts:158:5)
        at /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/TASK-110 branch/apps/web/tests/e2e/flow-07/flow-07.spec.ts:235:5

    Error Context: reports/flow-07/pw-output/flow-07--TASK-110-FLOW-07--98f08--no-longer-holds-the-record-chromium/error-context.md

    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    reports/flow-07/pw-output/flow-07--TASK-110-FLOW-07--98f08--no-longer-holds-the-record-chromium/trace.zip
    Usage:

        pnpm exec playwright show-trace reports/flow-07/pw-output/flow-07--TASK-110-FLOW-07--98f08--no-longer-holds-the-record-chromium/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────

  1 failed
    [chromium] › tests/e2e/flow-07/flow-07.spec.ts:200:3 › @TASK-110 @FLOW-07 delete a draft or campaign end to end › campaign: SCREEN-005 delete-confirm (keyboard only) -> deleted toast; the list no longer holds the record 
  12 passed (4.2m)
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-07/junit.xml` | 434 | 1 | 0 | FAIL |
| `apps/web/reports/flow-07/e2e-junit.xml` | 13 | 1 | 0 | FAIL |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-07/lcov.info` | is missing: the check that should write it did not | - | - | - | - |

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
- `docs/evidence/TASK-110/README.md`: 3861 bytes
