# Submit check: PASS

- Commit: `7cbd17d8b1cb14660db7c62d537fef580619268c` on `feature/AIU-174-(TASK-109 branch)`
- Base: `origin/dev` at `9ca9008675de64c193fb96ae1874ec80356432c6`
- Run at: 2026-11-17 22:58 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `cd apps/web && REPORT_DIR=reports/flow-06 NODE_ENV=test pnpm exec vitest run --config vitest.config.ts --coverage` | 0 | 46 |
| `cd apps/web && pnpm exec playwright test --config tests/e2e/flow-06/playwright.config.ts --project=chromium` | 0 | 77 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/flow-06/junit.xml` | 448 | 0 | 0 | pass |
| `apps/web/reports/flow-06/e2e-junit.xml` | 15 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/flow-06/lcov.info` | lcov | 91.21% (min 75) | 85.20% (min 70) | 86.36% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 1 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |

### Dismissed in `reports/deps.sarif`

- High `CVE-2026-112366` at `file:///paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-174-(TASK-109 branch)/pnpm-lock.yaml`: picomatch@4.0.7 (ReDoS on attacker-supplied extglob patterns) is reached only through development tooling (dependency-cruiser, typescript-eslint, vite via tinyglobby) and is not in the web or api runtime bundle. No untrusted glob reaches it. Published after the TASK-089 check passed; verified with pnpm why (devDependencies only); the lockfile is shared and unchanged by this ticket, so the upgrade belongs to the dependency owner. Not a change of this ticket. (Frontend Engineer, until 2026-12-16)

### Dismissed in `reports/secrets.sarif`

- Secret `openai-key-shaped` at `docs/evidence/TASK-109/submit-check.md:3`: False positive: gitleaks reads '(task id)-flow-...' inside the branch name 'feature/AIU-174-(TASK-109 branch)...' ('ta' + '(task id)...') written in the earlier committed submit-check.md report (commits 6d6578c, removed again in 97b57f1). It is a Git branch name, not a credential; no key exists. The report is not recommitted with that line. (Frontend Engineer, until 2026-12-16)
- Secret `openai-key-shaped` at `docs/evidence/TASK-109/submit-check.md:37`: False positive: gitleaks reads '(task id)-flow-...' inside the branch name 'feature/AIU-174-(TASK-109 branch)...' ('ta' + '(task id)...') written in the earlier committed submit-check.md report (commits 6d6578c, removed again in 97b57f1). It is a Git branch name, not a credential; no key exists. The report is not recommitted with that line. (Frontend Engineer, until 2026-12-16)

## Evidence in the commit

- `docs/evidence/TASK-109/screenshots/`: 1918 bytes
