# Submit check: PASS

- Commit: `c1e950172bd72573a745b01b74162ac803e8403a` on branch AIU-162 (TASK-096)
- Base: `origin/dev` at `171300d8e922ed65589c22c21f120be4977de3fd`
- Run at: 2026-11-17 15:53 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 4 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 3 |
| `REPORT_DIR=reports/fe-screen-009a pnpm --filter @shroomap/web test` | 0 | 49 |
| `pnpm --filter @shroomap/ui test` | 0 | 48 |
| `node docs/evidence/TASK-096/e2e-with-database.mjs` | 0 | 71 |
| `scripts/ci/token-lint.sh` | 0 | 2 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 16 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-009a/junit.xml` | 422 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-009a/e2e-junit.xml` | 24 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-009a/lcov.info` | lcov | 91.01% (min 75) | 84.75% (min 70) | 85.15% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-096/screenshots/`: 831 bytes
