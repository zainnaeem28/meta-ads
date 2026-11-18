# Submit check: PASS

- Commit: `b45c38468eb43d24d9b4cfd4211565430e92cb69` on `feature/AIU-167-task-106-flow-flow-03-end-to-end-generate-clips-qc-retry`
- Base: `origin/dev` at `286c502c680411fc97192b574a11321f03d3bac9`
- Run at: 2026-11-18 01:07 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 4 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 2 |
| `REPORT_DIR=reports/flow-03 pnpm --filter @shroomap/web test` | 0 | 31 |
| `cd apps/web && REPORT_DIR=reports/flow-03 pnpm exec playwright test --config tests/e2e/flow-03/playwright.config.ts --project=chromium` | 0 | 181 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 17 |
| `scripts/ci/deps.sh` | 0 | 4 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-03/junit.xml` | 448 | 0 | 0 | pass |
| `apps/web/reports/flow-03/e2e-junit.xml` | 8 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-03/lcov.info` | lcov | 91.21% (min 75) | 85.20% (min 70) | 86.36% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-167-task-106-flow-flow-03-end-to-end-generate-clips-qc-retry/pnpm-lock.yaml`: picomatch 4.0.7 (GHSA-fc5q-39xc-vjpf, regex DoS via single-branch repeated extglob such as +(*)); no patched version exists (latest published is 4.0.7), so no upgrade or override is possible. Reached only through build and test tooling: dependency-cruiser, typescript-eslint, vite/vitest (dev), and @sentry/nextjs -> @rollup/plugin-commonjs and vite via tinyglobby (build-time bundler plugins). Every glob given to it is a literal from this repository's own config or from the build; no request-handling or user-supplied glob reaches it, and the API runtime image does not use it (pnpm why --prod shows it only under @shroomap/web build dependencies). Re-check for a patched release at expiry. Needs Security Reviewer review. (DevOps Engineer, until 2026-12-17)

## Evidence in the commit

- `docs/evidence/TASK-106/screenshots/`: 1595 bytes
