# Submit check: PASS

- Commit: `e9fbe10b743ebd08e4cf94db0d7c0eb57a59ff52` on `feature/AIU-79-task-115-security-scan-configuration-custom-semgrep-rules-gitleaks-patterns-canary-proof-bundle-scan-push`
- Base: `origin/dev` at `f36e873125912903295d462f02d5352fd4ee33c7`
- Run at: 2026-11-15 20:43 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `scripts/ci/security/run-fixtures.sh` | 0 | 34 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `reports/security/junit.xml` | 40 | 0 | 0 | pass |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-115/submit-check.md`: 1012 bytes
