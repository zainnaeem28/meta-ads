# Submit check: PASS

- Commit: `782eb1593197ba588cfc143f574f3887fdd38da4` on `feature/AIU-167-task-106-flow-flow-03-end-to-end-generate-clips-qc-retry`
- Base: `origin/dev` at `8739c57fc8afe391bb699240cb8f3fa558767096`
- Run at: 2026-11-17 22:23 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 7 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 7 |
| `REPORT_DIR=reports/flow-03 pnpm --filter @shroomap/web test` | 0 | 47 |
| `cd apps/web && REPORT_DIR=reports/flow-03 pnpm exec playwright test --config tests/e2e/flow-03/playwright.config.ts --project=chromium` | 0 | 184 |
| `scripts/ci/token-lint.sh` | 0 | 2 |
| `scripts/ci/layers.sh` | 0 | 3 |
| `scripts/ci/sast.sh` | 0 | 12 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-03/junit.xml` | 446 | 0 | 0 | pass |
| `apps/web/reports/flow-03/e2e-junit.xml` | 8 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-03/lcov.info` | lcov | 90.73% (min 75) | 84.93% (min 70) | 85.39% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-167-task-106-flow-flow-03-end-to-end-generate-clips-qc-retry/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby; verified with pnpm why, devDependencies only) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-096 check passed; the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-106/screenshots/`: 1595 bytes
