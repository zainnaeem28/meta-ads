# Submit check: PASS

- Commit: `4503094c22a877e93a168308055c8d7a9d21686d` on `feature/AIU-140-task-067-cmp-002-icon-set-and-the-gallery-shell-with-the-visual-baseline-and-axe-harness`
- Base: `origin/dev` at `123fd6828944e9904cb6e35a0f1d02ea54a7d77b`
- Run at: 2026-11-15 22:43 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web run test` | 0 | 4 |
| `pnpm --filter @shroomap/ui test` | 0 | 1 |
| `cd apps/web && pnpm exec playwright test --project=chromium --grep @TASK-067` | 0 | 11 |
| `scripts/ci/token-lint.sh` | 0 | 0 |
| `scripts/ci/layers.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/icons-gallery/junit.xml` | 8 | 0 | 0 | pass |
| `apps/web/reports/icons-gallery/e2e-junit.xml` | 6 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/icons-gallery/lcov.info` | lcov | 100.00% (min 75) | 100.00% (min 70) | 100.00% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.json` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-067/screenshots/`: 124 bytes
