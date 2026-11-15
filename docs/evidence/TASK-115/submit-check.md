# Submit check: PASS

- Commit: `ee0c5ee7366cee204f02f6cec24890e7b0981e41` on `feature/AIU-79-task-115-security-scan-configuration-custom-semgrep-rules-gitleaks-patterns-canary-proof-bundle-scan-push`
- Base: `origin/dev` at `544b6f29b0a1c91305ddb8f6408bb7111667a948`
- Run at: 2026-11-15 20:39 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `scripts/ci/security/run-fixtures.sh` | 0 | 18 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `reports/security/junit.xml` | 39 | 0 | 0 | pass |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-115/submit-check.md`: 1097 bytes
