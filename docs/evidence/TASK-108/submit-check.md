# Submit check: PASS

- Commit: `d0f1c307487e9dd6f24d68313d9d9b973973e51d` on `feature/AIU-175-task-108-flow-flow-05-end-to-end-sign-in-and-mfa`
- Base: `origin/dev` at `7668b0bf43685eda96d4025484dabbcda9e430d6`
- Run at: 2026-11-17 19:36 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm build` | 0 | 46 |
| `cd apps/web && REPORT_DIR=reports/flow-05 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 55 |
| `cd apps/web && REPORT_DIR=reports/flow-05 pnpm exec playwright test --config tests/e2e/flow-05/playwright.config.ts --project=chromium` | 0 | 89 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 7 |
| `scripts/ci/sast.sh` | 0 | 48 |
| `scripts/ci/deps.sh || true` | 0 | 5 |
| `scripts/ci/secrets.sh` | 0 | 3 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-05/junit.xml` | 439 | 0 | 0 | pass |
| `apps/web/reports/flow-05/e2e-junit.xml` | 27 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-05/lcov.info` | lcov | 90.60% (min 75) | 84.86% (min 70) | 85.31% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-175-task-108-flow-flow-05-end-to-end-sign-in-and-mfa/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-108/screenshots/`: 1119 bytes
