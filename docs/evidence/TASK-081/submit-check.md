# Submit check: PASS

- Commit: `3c08e54c537827933fb74c5053e8ea6245bdcf53` on `feature/AIU-187-task-081-gallery-completion-every-component-state-sheets-cmp-sheet-01-04-parity-full-axe-and-visual-base`
- Base: `origin/dev` at `cd7f024081ed7bc356e6702b2cb6c2e682c441b6`
- Run at: 2026-11-16 16:04 UTC

## Checks

| Command | Exit | Seconds |
| --- | --- | --- |
| `pnpm --filter @shroomap/api build && GALLERY_ENABLED=true pnpm --filter @shroomap/web build` | 0 | 25 |
| `bash /tmp/aiu187_unit.sh` | 0 | 16 |
| `NODE_ENV=test pnpm --filter @shroomap/ui test` | 0 | 26 |
| `bash /tmp/aiu187_e2e.sh` | 0 | 158 |
| `scripts/ci/token-lint.sh` | 0 | 1 |
| `scripts/ci/layers.sh` | 0 | 2 |
| `scripts/ci/sast.sh` | 0 | 9 |
| `scripts/ci/deps.sh` | 0 | 3 |
| `scripts/ci/secrets.sh` | 0 | 2 |

## Test reports

| Report | Tests | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `apps/web/reports/gallery/junit.xml` | 172 | 0 | 0 | pass |
| `apps/web/reports/gallery/e2e-junit.xml` | 72 | 0 | 0 | pass |

## Coverage

| Report | Format | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- | --- |
| `apps/web/reports/gallery/lcov.info` | lcov | 93.93% (min 75) | 91.60% (min 70) | 88.82% | not measured |

## Security reports (findings block at High and above; secrets always)

| Report | Tool | Critical | High | Medium | Low | Info | Unrated | Blocking | Dismissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports/sast.sarif` | Semgrep OSS | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `reports/deps.sarif` | osv-scanner | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| `reports/secrets.sarif` | gitleaks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Evidence in the commit

- `docs/evidence/TASK-081/screenshots/`: 3566 bytes
- `docs/evidence/TASK-081/README.md`: 9371 bytes
