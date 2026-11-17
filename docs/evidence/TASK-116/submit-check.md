# Submit check: PASS

- Commit: `77161e945932dd6c33c8617916fc1fbfd75594bd`
- Base: `origin/dev` at `e9f269ddb00801802eaf7fd66b540019d949faf9`
- Run at: 2026-11-17 13:00 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api test:security` | 0 | 60 |
| `node apps/api/tests/security/support/scan-sinks.mjs --out reports/sinks.sarif apps/api/reports/security docs/evidence/TASK-116` | 0 | 0 |
| `scripts/ci/sast.sh` | 0 | 20 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |
| `python3 -I -c "import json,glob;m=[];[m.extend(json.load(open(f))[k]) for f in glob.glob(\"reports/findings/deps*.json\") for k in (\"blocking\",\"nonBlocking\")];json.dump({\"findings\":m},open(\"reports/deps.json\",\"w\"))"` | 0 | 0 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/api/reports/security/junit.xml` | 47 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/api/reports/security/lcov.info` | lcov | 98.44% (min 80) | 77.78% (min 75) | 81.25% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.json` | finding list | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-116/submit-check.md`: 57 bytes
