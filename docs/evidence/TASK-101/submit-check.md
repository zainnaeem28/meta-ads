# Submit check: PASS

- Commit: `63e3e7f4b0a5dea4451d62a79b72666a9e547e46` on `feature/AIU-183-task-101-admin-settings-sign-up-mode-and-read-only-security-configuration-screen-013`
- Base: `origin/dev` at `26ce9fd0fc77384d641199991107aa721cc9f3a3`
- Run at: 2026-11-16 16:15 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `scripts/ci/token-lint.sh; scripts/ci/layers.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-013/junit.xml` | 183 | 0 | 0 | pass |
| `apps/web/reports/fe-screen-013/e2e-junit.xml` | 15 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/fe-screen-013/lcov.info` | lcov | 95.18% (min 75) | 92.21% (min 70) | 88.95% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/audit.json` | npm/pnpm audit | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-101/screenshots/`: 529 bytes
