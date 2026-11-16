# Submit check: PASS

- Commit: `10b938bde84152376933b692ba646a48416966b2` on `feature/AIU-183-task-101-admin-settings-sign-up-mode-and-read-only-security-configuration-screen-013`
- Base: `origin/dev` at `039286dfd0500f5edf8b80130d1e846efe16f7ce`
- Run at: 2026-11-16 16:51 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-013/junit.xml` | 194 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-013/e2e-junit.xml` | 15 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-013/lcov.info` | lcov | 95.06% (min 75) | 90.86% (min 70) | 88.53% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-101/screenshots/`: 529 bytes
