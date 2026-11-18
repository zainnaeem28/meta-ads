# Submit check: PASS

- Commit: `0c0ac7e5bdd1ee2bb42c02a47ce75bb8053eba89` on `feature/AIU-176`
- Base: `origin/dev` at `9ca9008675de64c193fb96ae1874ec80356432c6`
- Run at: 2026-11-17 23:06 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/matrix NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 39 |
| `cd apps/web && REPORT_DIR=reports/matrix WEB_PORT=3376 E2E_PROD_PORT=3377 E2E_API_PORT=4376 pnpm exec playwright test --config tests/matrix/playwright.config.ts --grep @matrix` | 0 | 42 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 5 |
| `scripts/ci/sast.sh` | 0 | 18 |
| `scripts/ci/deps.sh || true` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/matrix/junit.xml` | 448 | 0 | 0 | pass |
| `apps/web/reports/matrix/e2e-junit.xml` | 36 | 0 | 24 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/matrix/lcov.info` | lcov | 91.21% (min 75) | 85.20% (min 70) | 86.36% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-117/screenshots/`: 576 bytes
