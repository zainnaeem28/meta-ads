# Submit check: PASS

- Commit: `447b2581dff79cbd5dd264a3e146fb41c878ee65` on `TASK-105 branch`
- Base: `origin/dev` at `2e5dd95ddab2ff335eb6d0f9a510d9289dc09d38`
- Run at: 2026-11-17 17:10 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/flow-02 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 32 |
| `cd apps/web && REPORT_DIR=reports/flow-02 pnpm exec playwright test --config tests/e2e/flow-02/playwright.config.ts --project=chromium` | 0 | 65 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 4 |
| `scripts/ci/sast.sh` | 0 | 20 |
| `scripts/ci/deps.sh || true` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-02/junit.xml` | 434 | 0 | 0 | pass |
| `apps/web/reports/flow-02/e2e-junit.xml` | 15 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-02/lcov.info` | lcov | 91.13% (min 75) | 84.87% (min 70) | 85.26% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/TASK-105 branch/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-105/screenshots/`: 1748 bytes
