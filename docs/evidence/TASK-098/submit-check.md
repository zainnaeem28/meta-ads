# Submit check: PASS

- Commit: `df176280c9860cb73964ed4b4efb7820fb995d3e` on `feature/AIU-160-task-098-provider-keys-add-test-replace-delete-event-trail-screen-010`
- Base: `origin/dev` at `68dc1c467a04ac7b2be44fc6d2ce6b1c55712b3f`
- Run at: 2026-11-16 17:13 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 3 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 2 |
| `pnpm --filter @shroomap/web test` | 0 | 12 |
| `pnpm --filter @shroomap/ui test` | 0 | 28 |
| `cd apps/web && pnpm exec playwright test --project=chromium --grep @TASK-098` | 0 | 69 |
| `scripts/ci/token-lint.sh` | 0 | 2 |
| `scripts/ci/layers.sh` | 0 | 5 |
| `scripts/ci/sast.sh` | 0 | 14 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 3 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-010/junit.xml` | 231 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-010/e2e-junit.xml` | 30 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-010/lcov.info` | lcov | 95.04% (min 75) | 90.86% (min 70) | 89.42% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-098/screenshots/`: 1191 bytes
- `docs/evidence/TASK-098/README.md`: 1527 bytes
