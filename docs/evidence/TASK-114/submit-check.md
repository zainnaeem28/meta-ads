# Submit check: PASS

- Commit: `6c0c040258d517d538e2d08ed0424acd69df7d50` on `the ticket branch`
- Base: `origin/dev` at `ccc68f382f5d3aa786aae092826170dd4e29c68b`
- Run at: 2026-11-17 19:17 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/web lint` | 0 | 5 |
| `pnpm --filter @shroomap/web typecheck` | 0 | 4 |
| `REPORT_DIR=reports/flow-13 pnpm --filter @shroomap/web test` | 0 | 48 |
| `cd apps/web && EVIDENCE_DIR=../../docs/evidence/TASK-114 pnpm exec playwright test -c tests/e2e/flow-13/playwright.config.ts --project=chromium` | 0 | 49 |
| `scripts/ci/token-lint.sh` | 0 | 2 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 9 |
| `scripts/ci/deps.sh` | 0 | 2 |
| `scripts/ci/secrets.sh` | 0 | 1 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-13/junit.xml` | 439 | 0 | 0 | pass |
| `apps/web/reports/flow-13/e2e-junit.xml` | 12 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-13/lcov.info` | lcov | 90.60% (min 75) | 84.86% (min 70) | 85.31% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/audit.json` | npm/pnpm audit | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/the ticket branch/pnpm-lock.yaml`: picomatch 4.0.7 (GHSA-fc5q-39xc-vjpf, regex DoS via single-branch repeated extglob such as +(*)); no patched version exists (latest published is 4.0.7), so no upgrade or override is possible. Reached only through build and test tooling: dependency-cruiser, typescript-eslint, vite/vitest (dev), and @sentry/nextjs -> @rollup/plugin-commonjs and vite via tinyglobby (build-time bundler plugins). Every glob given to it is a literal from this repository's own config or from the build; no request-handling or user-supplied glob reaches it, and the API runtime image does not use it (pnpm why --prod shows it only under @shroomap/web build dependencies). Re-check for a patched release at expiry. Needs Security Reviewer review. (DevOps Engineer, until 2026-12-17)

### Dismissed in `reports/audit.json`

- High `GHSA-fc5q-39xc-vjpf` at `picomatch`: picomatch 4.0.7 (GHSA-fc5q-39xc-vjpf, regex DoS via single-branch repeated extglob such as +(*)); no patched version exists (latest published is 4.0.7), so no upgrade or override is possible. Reached only through build and test tooling: dependency-cruiser, typescript-eslint, vite/vitest (dev), and @sentry/nextjs -> @rollup/plugin-commonjs and vite via tinyglobby (build-time bundler plugins). Every glob given to it is a literal from this repository's own config or from the build; no request-handling or user-supplied glob reaches it, and the API runtime image does not use it (pnpm why --prod shows it only under @shroomap/web build dependencies). Re-check for a patched release at expiry. Needs Security Reviewer review. (DevOps Engineer, until 2026-12-17)

## Evidence in the commit

- `docs/evidence/TASK-114/screenshots/`: 733 bytes
