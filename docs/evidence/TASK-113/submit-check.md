# Submit check: PASS

- Commit: `00acd6a32d34c64f2a836b20540952fa1bfeb60b` on `feature/AIU-186-… (branch)`
- Base: `origin/dev` at `9ca9008675de64c193fb96ae1874ec80356432c6`
- Run at: 2026-11-17 23:01 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `scripts/ci/lint.sh` | 0 | 33 |
| `scripts/ci/types.sh` | 0 | 23 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/unit.sh ci` | 0 | 8 |
| `scripts/ci/contract.sh` | 0 | 10 |
| `scripts/ci/sast.sh` | 0 | 11 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 1 |
| `scripts/ci/probes/run-all.sh` | 0 | 16 |
| `cd apps/web && pnpm exec playwright test --config tests/e2e/flow-12/playwright.config.ts --project=chromium` | 0 | 130 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `reports/ci/junit.xml` | 40 | 0 | 0 | pass |
| `apps/web/reports/flow-12/e2e-junit.xml` | 12 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `reports/ci/lcov.info` | lcov | 97.97% (min 80) | 96.24% (min 75) | 100.00% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/audit.json` | npm/pnpm audit | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-186-… (branch)/pnpm-lock.yaml`: picomatch 4.0.7 (GHSA-fc5q-39xc-vjpf, regex DoS via single-branch repeated extglob such as +(*)); no patched version exists (latest published is 4.0.7), so no upgrade or override is possible. Reached only through build and test tooling: dependency-cruiser, typescript-eslint, vite/vitest (dev), and @sentry/nextjs -> @rollup/plugin-commonjs and vite via tinyglobby (build-time bundler plugins). Every glob given to it is a literal from this repository's own config or from the build; no request-handling or user-supplied glob reaches it, and the API runtime image does not use it (pnpm why --prod shows it only under @shroomap/web build dependencies). Re-check for a patched release at expiry. Needs Security Reviewer review. (DevOps Engineer, until 2026-12-17)

### Dismissed in `reports/audit.json`

- High `GHSA-fc5q-39xc-vjpf` at `picomatch`: picomatch 4.0.7 (GHSA-fc5q-39xc-vjpf, regex DoS via single-branch repeated extglob such as +(*)); no patched version exists (latest published is 4.0.7), so no upgrade or override is possible. Reached only through build and test tooling: dependency-cruiser, typescript-eslint, vite/vitest (dev), and @sentry/nextjs -> @rollup/plugin-commonjs and vite via tinyglobby (build-time bundler plugins). Every glob given to it is a literal from this repository's own config or from the build; no request-handling or user-supplied glob reaches it, and the API runtime image does not use it (pnpm why --prod shows it only under @shroomap/web build dependencies). Re-check for a patched release at expiry. Needs Security Reviewer review. (DevOps Engineer, until 2026-12-17)

## Evidence in the commit

- `docs/evidence/TASK-113/screenshots/`: 2233 bytes
