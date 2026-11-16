# Submit check: FAIL

- Commit: `d1237facf100e65ee2ef958f205c24c67c793351` on `feature/AIU-153-task-088-access-states-not-linked-request-pending-suspended-removed-invite-invalid-screen-002`
- Base: `origin/dev` at `039286dfd0500f5edf8b80130d1e846efe16f7ce`
- Run at: 2026-11-16 16:41 UTC

## Problems

- `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && REPORT_DIR=reports/fe-screen-002 pnpm --filter @shroomap/web test` exited 1.
- Test report `apps/web/reports/fe-screen-002/junit.xml` is older than the commit: it comes from an earlier revision; rerun the check.
- Coverage report `apps/web/reports/fe-screen-002/lcov.info` is older than the commit: it comes from an earlier revision; rerun the check.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 21 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && REPORT_DIR=reports/fe-screen-002 pnpm --filter @shroomap/web test` | 1 | 4 |
| `pnpm --filter @shroomap/ui test` | 0 | 31 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/fe-screen-002/e2e-junit.xml REPORT_DIR=reports/fe-screen-002 WEB_PORT=3158 E2E_API_PORT=4158 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu152_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-088 --reporter=junit` | 0 | 33 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 24 |
| `scripts/ci/deps.sh` | 0 | 6 |
| `scripts/ci/secrets.sh` | 0 | 3 |

### `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && REPORT_DIR=reports/fe-screen-002 pnpm --filter @shroomap/web test` (last 30 lines)

```

> @shroomap/web@0.0.0 lint /paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-153-task-088-access-states-not-linked-request-pending-suspended-removed-invite-invalid-screen-002/apps/web
> eslint .


/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-153-task-088-access-states-not-linked-request-pending-suspended-removed-invite-invalid-screen-002/apps/web/src/features/fe-screen-002/AccessScreen.tsx
  14:28  error  'SCREEN_002_COPY' is defined but never used  @typescript-eslint/no-unused-vars

✖ 1 problem (1 error, 0 warnings)

/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-153-task-088-access-states-not-linked-request-pending-suspended-removed-invite-invalid-screen-002/apps/web:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @shroomap/web@0.0.0 lint: `eslint .`
Exit status 1
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-002/junit.xml` | - | - | - | is older than the commit: it comes from an earlier revision; rerun the check |
| `apps/web/reports/fe-screen-002/e2e-junit.xml` | 18 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-002/lcov.info` | is older than the commit: it comes from an earlier revision; rerun the check | - | - | - | - |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-088/screenshots/`: 475 bytes
