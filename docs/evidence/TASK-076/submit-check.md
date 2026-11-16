# Submit check: PASS

- Commit: `e553b24180143896dd563ec394257d6b5cc6f517` on `feature/AIU-146-task-076-domain-components-a-job-card-claim-issue-segment-editor-cmp-022-023-024`
- Base: `origin/dev` at `a0c6f5067d7bd953fd26d18f6f4bd1b3ec0057eb`
- Run at: 2026-11-16 11:44 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint typecheck test; pnpm --filter @shroomap/ui test; (cd apps/web && pnpm exec playwright test --project=chromium --grep @TASK-076); scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 38 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/dom-a/junit.xml` | 50 | 0 | 0 | pass |
| `apps/web/reports/dom-a/e2e-junit.xml` | 5 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/dom-a/lcov.info` | lcov | 98.00% (min 75) | 91.82% (min 70) | 90.38% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-076/screenshots/`: 83 bytes
