# TASK-066 evidence

- `design/` imported byte-identical from commit 48ebc1a (branch `feature/AIU-14-…`): `design-hashes.txt` lists the git blob hash of every file at the source commit and in this tree; `diff` of the two is empty.
- `home-390.png`, `home-1440.png`: built web (`next start`) with the self-hosted Inter, captured by the `@TASK-066` Playwright test.
- Token lint: `scripts/ci/token-lint.sh` (tree) and `scripts/ci/token-lint.sh --self-test` (negative fixtures: raw hex, rgb(), `w-[13px]`, `[color:red]`, `13px`, Google Fonts `@import`, remote `@font-face`, `next/font/google`) both exit 0.
- Network capture: the e2e test records every request of the page and asserts none leaves the web origin; CDP `CSS.getPlatformFontsForNode` reports `Inter` as a custom font.

Limitations: axe-core is not in the lockfile, so no axe run on the test page (single text line, no components yet); the e2e api is the built api started with the fixture configuration (`tools/foundation-tests/api-env.ts`), checked on `/health/live`, no database. Files outside the ticket's allowed paths that this ticket needed: `apps/web/{postcss.config.mjs,playwright.config.ts,vitest.config.ts,e2e/**,src/design/**,package.json}`, `apps/web/src/app/page.tsx`, `pnpm-lock.yaml`, `eslint.config.mjs` and `.prettierignore` (ignore `design/`).
