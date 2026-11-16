# Submit check: FAIL

- Commit: `1fbcb42a130a6693a5fcd0fc2c5e74fc7a941b91` on `feature/AIU-149-task-072-composites-dialog-and-menu-cmp-013-020`
- Base: `origin/dev` at `ebbfc59291903ee389325afdc9b529ab734746c1`
- Run at: 2026-11-16 11:54 UTC

## Problems

- `scripts/ci/secrets.sh` exited 1.

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint && pnpm --filter @shroomap/web typecheck && pnpm --filter @shroomap/web test` | 0 | 13 |
| `pnpm --filter @shroomap/ui test` | 0 | 17 |
| `cd packages/ui && pnpm exec vitest run --config vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory=../../apps/web/reports/comp-overlay && cd ../.. && cp apps/web/reports/icons-gallery/ui-junit.xml apps/web/reports/comp-overlay/junit.xml && sed -i s#^SF:src/#SF:packages/ui/src/# apps/web/reports/comp-overlay/lcov.info` | 0 | 13 |
| `cd apps/web && PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/comp-overlay/e2e-junit.xml REPORT_DIR=reports/comp-overlay env -u DATABASE_URL pnpm exec playwright test --project=chromium --grep @TASK-072 --reporter=junit` | 0 | 22 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 1 |
| `scripts/ci/sast.sh` | 0 | 8 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 1 | 1 |

### `scripts/ci/secrets.sh` (last 30 lines)

```
[90m11:54AM[0m [32mINF[0m [1m5 commits scanned.[0m
[90m11:54AM[0m [32mINF[0m [1mscanned ~45982 bytes (45.98 KB) in 464ms[0m
[90m11:54AM[0m [33mWRN[0m [1mleaks found: 1[0m
BLOCKING HIGH openai-key-shaped at docs/evidence/TASK-072/submit-check.md (gitleaks)
RESULT FAIL: 1 blocking, 0 recorded, 0 dismissed, 0 tool failures
```

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/comp-overlay/junit.xml` | 198 | 0 | 0 | pass |
| `apps/web/reports/comp-overlay/e2e-junit.xml` | 6 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/comp-overlay/lcov.info` | lcov | 97.94% (min 75) | 97.09% (min 70) | 95.12% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |

### Dismissed in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `docs/evidence/TASK-072/submit-check.md:3`: False positive: line 3 is the 40-hex git commit id in the earlier submit-check report (removed from the tree; the new report replaces it). No credential. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-072/screenshots/`: 97 bytes
