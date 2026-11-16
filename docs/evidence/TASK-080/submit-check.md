# Submit check: PASS

- Commit: `6d123485b27d269fe9cb200a0419f488a281a6cd` on `feature/AIU-178-task-080-admin-shell-portal-tag-top-rule-alert-count-badge-cmp-031`
- Base: `origin/dev` at `9654deaa8eb1007fd7120a7c76056d6a0492aff3`
- Run at: 2026-11-16 14:55 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 33 |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 30 |
| `pnpm --filter @shroomap/ui test` | 0 | 34 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/shell-admin && cd ../.. && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/shell-admin/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/shell-admin/lcov.info` | 0 | 31 |
| `bash /tmp/aiu178_run.sh` | 0 | 45 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 26 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/shell-admin/junit.xml` | 345 | 0 | 0 | pass |
| `apps/web/reports/shell-admin/e2e-junit.xml` | 8 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/shell-admin/lcov.info` | lcov | 97.41% (min 75) | 96.29% (min 70) | 93.48% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-080/screenshots/`: 999 bytes
