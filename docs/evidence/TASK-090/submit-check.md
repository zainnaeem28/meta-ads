# Submit check: PASS

- Commit: `aa8dbb90a4aeed8af43f0286f963e65594c1fb67` on `feature/AIU-172-task-090-campaigns-history-drafts-search-and-filters-delete-screen-005`
- Base: `origin/dev` at `d98a09c1a8708976ee066d55bdfd330f5171abd8`
- Run at: 2026-11-17 07:14 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `REPORT_DIR=reports/fe-screen-005 pnpm --filter @shroomap/web lint` | 0 | 3 |
| `REPORT_DIR=reports/fe-screen-005 pnpm --filter @shroomap/web typecheck` | 0 | 2 |
| `REPORT_DIR=reports/fe-screen-005 pnpm --filter @shroomap/web test` | 0 | 24 |
| `pnpm --filter @shroomap/ui test` | 0 | 20 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/fe-screen-005/e2e-junit.xml WEB_PORT=3172 E2E_API_PORT=4172 E2E_DATABASE_URL=postgres://postgres@test-db:5432/aiu172_e2e env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-090 --reporter=junit` | 0 | 45 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 7 |
| `scripts/ci/deps.sh` | 0 | 3 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-005/junit.xml` | 365 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-005/e2e-junit.xml` | 25 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-005/lcov.info` | lcov | 90.42% (min 75) | 84.62% (min 70) | 84.89% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |

### Dismissed in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `docs/evidence/TASK-090/submit-check.md:3`: False positive: the report's branch line contains a hyphenated word run from the branch name, not a key. The file holds no credentials. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-090/screenshots/`: 892 bytes
