# Submit check: PASS

- Commit: `47850158762b48bff768a8b5c760779feea8a179` on `TASK-107 branch`
- Base: `origin/dev` at `c542a3fa7ea08401336275a8b671650fab219674`
- Run at: 2026-11-17 19:06 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/flow-04 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 48 |
| `cd apps/web && REPORT_DIR=reports/flow-04 pnpm exec playwright test --config tests/e2e/flow-04/playwright.config.ts --project=chromium` | 0 | 154 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 4 |
| `scripts/ci/sast.sh` | 0 | 29 |
| `scripts/ci/deps.sh || true` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-04/junit.xml` | 439 | 0 | 0 | pass |
| `apps/web/reports/flow-04/e2e-junit.xml` | 21 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-04/lcov.info` | lcov | 91.15% (min 75) | 84.86% (min 70) | 85.31% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-107/screenshots/`: 1686 bytes
