# Submit check: PASS

- Commit: `1ebaba633e5520890f7761e6cbd82fb9de48056f` on `feature/AIU-231-aiu-228-implement-cmp-025-providerkeycard-and-cmp-030-operatorshell-parity-with-screen-010-frame`
- Base: `origin/dev` at `5b2d2d2999025d4b7d9c9e2d9ed567399efcc6f5`
- Run at: 2026-11-16 19:32 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/ui typecheck` | 0 | 4 |
| `pnpm --filter @shroomap/web lint` | 0 | 2 |
| `REPORT_DIR=reports/aiu-231 CI=1 pnpm --filter @shroomap/ui test` | 0 | 21 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 20 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/aiu-231/ui-junit.xml` | 348 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/aiu-231/ui/lcov.info` | lcov | 97.42% (min 80) | 95.81% (min 75) | 93.50% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/AIU-231/screenshots/dom-b-key-openai-active-1440.png`: 23531 bytes
- `docs/evidence/AIU-231/screenshots/shell-key-disabled-1440.png`: 31039 bytes
- `docs/evidence/AIU-231/screenshots/shell-user-sidebar-1440.png`: 28606 bytes
- `docs/evidence/AIU-231/screenshots/dom-b-key-wavespeed-none-390.png`: 12292 bytes
- `docs/evidence/AIU-231/screenshots/shell-auto-390.png`: 18822 bytes
