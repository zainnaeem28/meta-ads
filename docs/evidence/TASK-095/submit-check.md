# Submit check: PASS

- Commit: `31a4f9eaf9df96589a98311515ae0f1289f22600` on `feature/AIU-164-task-095-clips-generate-status-qc-review-retry-screen-008`
- Base: `origin/dev` at `84795ded6577d97298cbdc1b861c0174510339dc`
- Run at: 2026-11-17 11:56 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint; pnpm --filter @shroomap/web typecheck; REPORT_DIR=reports/fe-screen-008 pnpm --filter @shroomap/web test; pnpm --filter @shroomap/ui test; node docs/evidence/TASK-095/e2e-with-database.mjs; scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 137 |
| `scripts/ci/sast.sh` | 0 | 14 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-008/junit.xml` | 396 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-008/e2e-junit.xml` | 22 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-008/lcov.info` | lcov | 90.56% (min 75) | 84.68% (min 70) | 84.49% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-095/screenshots/`: 728 bytes
