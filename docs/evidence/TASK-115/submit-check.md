# Submit check: FAIL

- Commit: `330ae2b6972f837149c27244f0f19bb184972a63` on `feature/AIU-79-task-115-security-scan-configuration-custom-semgrep-rules-gitleaks-patterns-canary-proof-bundle-scan-push`
- Base: `origin/dev` at `544b6f29b0a1c91305ddb8f6408bb7111667a948`
- Run at: 2026-11-15 20:39 UTC

## Problems

- Evidence `docs/evidence/TASK-115/submit-check.md` is not in the commit.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `scripts/ci/security/run-fixtures.sh` | 0 | 29 |

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

- `docs/evidence/TASK-115/submit-check.md`: missing
