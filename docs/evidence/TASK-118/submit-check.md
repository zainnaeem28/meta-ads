# Submit check: PASS

- Commit: `8332c4cd8033e043fbd5a117d291f80ad0b63199` on `feature/AIU-188-task-118-accessibility-and-visual-coverage-suite-generated-from-the-screen-inventory`
- Base: `origin/dev` at `7668b0bf43685eda96d4025484dabbcda9e430d6`
- Run at: 2026-11-17 19:39 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/a11y NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 48 |
| `node scripts/ci/screen-coverage.mjs` | 0 | 0 |
| `cd apps/web && REPORT_DIR=reports/a11y WEB_PORT=3811 E2E_PROD_PORT=3812 E2E_API_PORT=4811 E2E_DATABASE_URL=postgres://postgres@test-db:5432/t_flow11_64b532c2566b pnpm exec playwright test --config tests/a11y/playwright.config.ts --grep @a11y --project=chromium` | 0 | 95 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 4 |
| `scripts/ci/sast.sh` | 0 | 11 |
| `scripts/ci/deps.sh || true` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/a11y/junit.xml` | 439 | 0 | 0 | pass |
| `apps/web/reports/a11y/e2e-junit.xml` | 52 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/a11y/lcov.info` | lcov | 90.60% (min 75) | 84.86% (min 70) | 85.31% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-188-task-118-accessibility-and-visual-coverage-suite-generated-from-the-screen-inventory/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-118/screenshots/`: 2610 bytes
- `docs/evidence/TASK-118/README.md`: 3846 bytes
- `docs/evidence/TASK-118/screen-coverage.md`: 53888 bytes
