# TASK-067 evidence (CMP-002 icons, gallery shell, visual and axe harness)

## What was built

- `packages/ui/src/icons/`: `Icon` (`name`, `size` 16 | 20 | 24, optional `label`), a registry of the 72 icons of `design/mockups/assets/icons/` (Lucide 1.73.0, ISC), 2 px stroke, `currentColor`; decorative by default (`aria-hidden`), `role="img"` plus `aria-label` when `label` is given. Exported as `@shroomap/ui/icons`. Unit test checks the registry equals the design folder and, for every icon at every size, the width/height, viewBox, stroke and the design's path data.
- Gallery shell `apps/web/src/app/gallery/`: `layout.tsx` (`notFound()` unless `GALLERY_ENABLED=true` and `APP_ENV` is not `production`; `noindex, nofollow` metadata; read per request, so one build serves both cases), `page.tsx`, `registry.ts` (`require.context('./sections')`: a component ticket adds `sections/<name>.tsx` exporting `meta: { id, title, order? }` and a default component, and edits nothing else). `sections/icons.tsx` is the CMP-002 section.
- Harness: `apps/web/playwright.config.ts` (projects chromium, firefox, webkit, edge channel `msedge`; reduced motion on; `toHaveScreenshot` threshold 0.1, `maxDiffPixelRatio` 0.001, animations disabled; junit to `reports/icons-gallery/e2e-junit.xml`; one baseline per project in `apps/web/e2e/__baselines__/<project>/`), `tests/support/visual.ts` (viewports 390, 768, 1440; settings; `expectScreenshot`), `tests/support/axe.ts` (`expectNoAxeViolations`, WCAG 2.2 AA tags, writes the violations file).
- Tests: `e2e/icons-gallery.spec.ts` (`@TASK-067`: 72 cells, three sizes, 2 px stroke, `currentColor` resolved, `aria-hidden`, `noindex`, 404 in a production deployment, baselines and axe at 390/768/1440, api health; `@harness`: sample page `/` baseline and axe, run in every project).

## Results (chromium, built web `next start` beside the built api)

- `CI=1 pnpm exec playwright test --project=chromium`: 16 passed (the six `@TASK-067`, three `@harness`, seven `@TASK-066`). axe: 0 violations at 390, 768 and 1440 on `/gallery` and `/` (`axe/*.json`).
- `pnpm --filter @shroomap/ui test`: 74 passed. `pnpm --filter @shroomap/web test`: 8 passed, coverage 100 % lines. Token lint and layer check: 0 violations.
- Screenshots (real self-hosted Inter): `screenshots/icons-390.png`, `icons-768.png`, `icons-1440.png`.

## Baseline approval

Baselines are generated on Linux only (`--update-snapshots`), committed with the ticket and approved by UI/UX in the review stage of the ticket that adds them. A later diff fails the test; whoever changes the visual output attaches the actual/expected/diff images to the ticket, UI/UX approves in a comment, and only then is the new baseline committed. The threshold (0.1 per pixel, 0.1 % of pixels) is set in `tests/support/visual.ts`; I found no earlier agreed value in the repository and chose these, so UI/UX should confirm or change them.

## Limitations

- Firefox, WebKit and Edge projects are configured and run only the `@harness` tests, but could **not be executed here**: their browsers cannot be installed in this sandbox (missing host libraries, no root), and Edge is not installed. Their baselines are therefore not generated; CI must run `--update-snapshots` per project once, and UI/UX approves them. Chromium ran with libraries and a fontconfig file from `/tmp/debs-066` (`LD_LIBRARY_PATH`, `FONTCONFIG_FILE`).
- `GALLERY_ENABLED` is read by the web app but is not in `config/registry.json` / `.env.example` (outside this ticket's paths); the Orchestrator should route that to the configuration owner.
- Files outside the allowed list that this ticket needed: `apps/web/{package.json,next.config.mjs (transpilePackages),vitest.config.ts,e2e/icons-gallery.spec.ts,e2e/__baselines__/**}`, `apps/web/src/app/gallery/sections/icons.tsx`, `packages/ui/{package.json,tsconfig.json,vitest.config.ts}`, `pnpm-lock.yaml`. The ports of the e2e servers can be set with `WEB_PORT`, `E2E_API_PORT` (the production-mode server uses `WEB_PORT + 1`).
- The first TASK-067 baseline run cannot detect regressions against an earlier baseline; the baselines are new.
