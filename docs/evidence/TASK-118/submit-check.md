# Submit check: FAIL

- Commit: `315d03d47a0b476234b12c306c7541c1db9d342f` on `feature/AIU-188-task-118-accessibility-and-visual-coverage-suite-generated-from-the-screen-inventory`
- Base: `origin/dev` at `ccc68f382f5d3aa786aae092826170dd4e29c68b`
- Run at: 2026-11-17 19:21 UTC

## Problems

- Not rebased: `origin/dev` has 9 commit(s) this branch lacks. Rebase, then rerun.
- Scanner report `reports/deps.sarif` has 1 blocking finding(s) at High or above, e.g. High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-188-task-118-accessibility-and-visual-coverage-suite-generated-from-the-screen-inventory/pnpm-lock.yaml`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/a11y NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 51 |
| `node scripts/ci/screen-coverage.mjs` | 0 | 0 |
| `cd apps/web && REPORT_DIR=reports/a11y WEB_PORT=3811 E2E_PROD_PORT=3812 E2E_API_PORT=4811 E2E_DATABASE_URL=postgres://postgres@test-db:5432/t_flow11_64b532c2566b pnpm exec playwright test --config tests/a11y/playwright.config.ts --grep @a11y --project=chromium` | 0 | 127 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 5 |
| `scripts/ci/sast.sh` | 0 | 38 |
| `scripts/ci/deps.sh || true` | 0 | 5 |
| `scripts/ci/secrets.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/a11y/junit.xml` | 439 | 0 | 0 | pass |
| `apps/web/reports/a11y/e2e-junit.xml` | 52 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/a11y/lcov.info` | lcov | 91.15% (min 75) | 84.86% (min 70) | 85.31% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 1 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Blocking in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-188-task-118-accessibility-and-visual-coverage-suite-generated-from-the-screen-inventory/pnpm-lock.yaml`

## Evidence in the commit

- `docs/evidence/TASK-118/screenshots/`: 2610 bytes
- `docs/evidence/TASK-118/README.md`: 3846 bytes
- `docs/evidence/TASK-118/screen-coverage.md`: 53970 bytes
