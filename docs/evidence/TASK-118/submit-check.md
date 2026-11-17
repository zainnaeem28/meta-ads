# Submit check: FAIL

- Commit: `af66151c1e10beab08685f66411661acc006b5d1` on `feature/AIU-188-task-118-accessibility-and-visual-coverage-suite-generated-from-the-screen-inventory`
- Base: `origin/dev` at `ccc68f382f5d3aa786aae092826170dd4e29c68b`
- Run at: 2026-11-17 19:25 UTC

## Problems

- `scripts/ci/secrets.sh` exited 1.
- Secret scan `reports/secrets.sarif` has 3 blocking secret finding(s), e.g. `openai-key-shaped` at `docs/evidence/TASK-118/submit-check.md:3`.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/a11y NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 54 |
| `node scripts/ci/screen-coverage.mjs` | 0 | 0 |
| `cd apps/web && REPORT_DIR=reports/a11y WEB_PORT=3811 E2E_PROD_PORT=3812 E2E_API_PORT=4811 E2E_DATABASE_URL=postgres://postgres@test-db:5432/t_flow11_64b532c2566b pnpm exec playwright test --config tests/a11y/playwright.config.ts --grep @a11y --project=chromium` | 0 | 117 |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 6 |
| `scripts/ci/sast.sh` | 0 | 15 |
| `scripts/ci/deps.sh || true` | 0 | 3 |
| `scripts/ci/secrets.sh` | 1 | 1 |

### `scripts/ci/secrets.sh` (last 30 lines)

```
[90m7:25PM[0m [32mINF[0m [1m2 commits scanned.[0m
[90m7:25PM[0m [32mINF[0m [1mscanned ~106504 bytes (106.50 KB) in 741ms[0m
[90m7:25PM[0m [33mWRN[0m [1mleaks found: 3[0m
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-118/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-118/submit-check.md (gitleaks)
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-118/submit-check.md (gitleaks)
RESULT FAIL: 3 blocking, 0 recorded, 0 dismissed, 0 tool failures
```

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
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 3 | 0 | 0 | 0 | 3 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-188-task-118-accessibility-and-visual-coverage-suite-generated-from-the-screen-inventory/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

### Blocking in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `docs/evidence/TASK-118/submit-check.md:3`
- Secret `openai-key-shaped` at `docs/evidence/TASK-118/submit-check.md:10`
- Secret `openai-key-shaped` at `docs/evidence/TASK-118/submit-check.md:47`

## Evidence in the commit

- `docs/evidence/TASK-118/screenshots/`: 2610 bytes
- `docs/evidence/TASK-118/README.md`: 3846 bytes
- `docs/evidence/TASK-118/screen-coverage.md`: 53888 bytes
