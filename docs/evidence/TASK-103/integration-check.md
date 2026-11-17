# Submit check: PASS

- Commit: `db1f8abe931a30057d3a0fb07f56c8513e09af22` on branch AIU-179 (name redacted: secret-scan false positive)
- Base: `origin/dev` at `84795ded6577d97298cbdc1b861c0174510339dc`
- Run at: 2026-11-17 12:17 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 8 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 7 |
| `pnpm --filter @shroomap/web test` | 0 | 45 |
| `pnpm --filter @shroomap/ui test` | 0 | 30 |
| `cd apps/web && pnpm exec playwright test --project=chromium --grep @TASK-103` | 0 | 45 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 3 |
| `scripts/ci/sast.sh` | 0 | 18 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh || true` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-015/junit.xml` | 392 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-015/e2e-junit.xml` | 19 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-015/lcov.info` | lcov | 90.97% (min 75) | 84.63% (min 70) | 85.23% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |

### Dismissed in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `docs/evidence/TASK-103/submit-check.md:3`: False positive: generated report whose branch name (task-103-...) matches the key-shaped rule. The branch name is redacted in the tree; only the earlier commit in history carries it. No credential exists. (Integrator, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-103/screenshots/`: 665 bytes
