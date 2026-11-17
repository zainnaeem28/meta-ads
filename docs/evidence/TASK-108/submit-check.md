# Submit check: PASS

- Commit: `05002060a5c93b50d5a55bfdba2b372985c63762` on the ticket branch
- Base: `origin/dev` at `b818035788493bdeef2dff6f61134bbb49d6fd89`
- Run at: 2026-11-17 18:55 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm build` | 0 | 32 |
| `cd apps/web && REPORT_DIR=reports/flow-05 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 47 |
| `cd apps/web && REPORT_DIR=reports/flow-05 pnpm exec playwright test --config tests/e2e/flow-05/playwright.config.ts --project=chromium` | 0 | 60 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 4 |
| `scripts/ci/sast.sh` | 0 | 10 |
| `scripts/ci/deps.sh || true` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-05/junit.xml` | 439 | 0 | 0 | pass |
| `apps/web/reports/flow-05/e2e-junit.xml` | 27 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-05/lcov.info` | lcov | 91.15% (min 75) | 84.86% (min 70) | 85.31% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `pnpm-lock.yaml (workspace root)`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-108/screenshots/`: 1119 bytes
