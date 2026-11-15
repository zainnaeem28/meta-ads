# TASK-069 evidence (CMP-003 Button, CMP-004 Input and textarea, CMP-005 Select, CMP-006 Choice controls)

## What was built

- `packages/ui/src/components/cmp-003..006/`, one subpath export each (`@shroomap/ui/cmp-003` ... `cmp-006`, no barrel): `Button`; `Input`, `KeyInput`, `Textarea`; `Select`; `Checkbox`, `RadioCard`, `SegmentedControl`, `Switch`. Tokens only (Tailwind utilities mapped to `tokens.css` in `theme.css`; token lint clean). Native elements throughout; `Button` supports `asChild` for anchors; disabled-by-scope controls (`unavailable`) show "Not in this release".
- Gallery section `apps/web/src/app/gallery/sections/fe-prim-a.tsx` (`CMP-003-006`): every variant and state as a `data-cell` cell. Hover, focus and active are reached by real interaction in the Playwright tests, not by forced classes.
- Tests: unit and axe (jsdom) beside each component; Playwright `apps/web/e2e/prim-a.spec.ts` (`@TASK-069`) through the built web app (`next start`) beside the built api.

## Results (chromium, built web beside built api)

- `pnpm --filter @shroomap/ui test`: 103 passed; coverage lines 98.5 %, branches 99.2 % (components threshold 75/70).
- `pnpm --filter @shroomap/web lint typecheck test`: pass, 8 tests.
- `playwright test --project=chromium --grep @TASK-069`: 47 passed: variant/state inventory, keyboard (Space/Enter/arrows), masked key input, pending width stable and `aria-busy`, 44/40/32 px targets at 390 and 1440 (and 768), axe WCAG 2.2 AA (including contrast) 0 violations at 390, 768 and 1440 (`axe/*.json`), baselines per group and per interactive state at 390 and 1440.
- Screenshots (real self-hosted Inter): `screenshots/`. Baselines: `apps/web/e2e/__baselines__/chromium/prim-a-*.png`, for UI/UX approval.

## Limitations and decisions

- Select has no read-only state: the native `select` has none; disabled, invalid, empty and filled are shown.
- jsdom unit axe runs with colour-contrast off (no layout); contrast is checked by the browser axe run.
- Files outside the allowed list this ticket needed: `packages/ui/{package.json (subpath exports, test dev dependencies), vitest.config.ts, tsconfig.json, test/**}`, `packages/ui/src/icons/icons.test.tsx` (node environment docblock), `apps/web/{playwright.config.ts, vitest.config.ts}` (report folder from `REPORT_DIR`), `apps/web/e2e/prim-a.spec.ts`, `apps/web/e2e/__baselines__/chromium/prim-a-*`, `pnpm-lock.yaml`.
- Reports were produced with `REPORT_DIR=prim-a`; `lcov.info` is the web lcov followed by the ui lcov with paths prefixed `../../packages/ui/`.
- Firefox, WebKit and Edge are not run for this ticket (components are not `@harness`).
- Baselines are new, generated on Linux chromium; they cannot detect a regression until UI/UX approves them.
