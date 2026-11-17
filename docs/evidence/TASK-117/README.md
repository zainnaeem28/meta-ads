# TASK-117: browser and device matrix (`@matrix`)

Run (from `apps/web`, after `pnpm build`): `CI=1 REPORT_DIR=reports/matrix pnpm exec playwright test --config tests/matrix/playwright.config.ts --grep @matrix`
(the same `matrix-*` projects are in `apps/web/playwright.config.ts`; the ticket's own config only adds the throwaway pg-boss database the built api needs, like TASK-118).

- Journeys: sign-in, FLOW-01 (wizard), FLOW-02 (brief), FLOW-03 (clips), FLOW-04 (assemble/download screen) on each project. Per project: no sideways scroll, full-page baseline (0.1 % pixels), browser version recorded in `versions/`. Phones: touch targets >= 44 px and no sideways scroll at 320 px.
- Zero-test rule: `tests/matrix/teardown.ts` fails the run if any configured project did not pass every journey.
- Reads are labelled contract-shaped mocks (the a11y suite's groups); sign-in and unanswered calls reach the real api.

## State on this server (2026-11-17)

| Project | Engine | Result |
| --- | --- | --- |
| matrix-chromium | Chrome for Testing 159.0.8154.6 | 6 passed, baselines recorded |
| matrix-android-chrome (Pixel 7) | Chrome for Testing 159.0.8154.6 | baselines recorded; **touch-target check fails** (below) |
| matrix-firefox, matrix-webkit, matrix-ios-safari | Firefox 159.0 / WebKit 27.2 downloaded | **cannot launch**: system libraries missing (libgtk-3, libXcursor, libpangocairo, ...) and no root to install them |
| matrix-edge | none | **Edge channel not installed** (`/opt/microsoft/msedge`), no root |

Baselines for the four unavailable projects do not exist yet; UI/UX approval of per-browser baselines is still to do for all six.

## Real defects found (outside this ticket's paths)

Touch targets under 44 px on the phone profile:
- `a "ShrooMap home"` 136x38 on every screen with the operator shell (`packages/ui/src/components/cmp-001/LogoLink.tsx`).
- `a "Campaigns"` 74x20, the page-header back/breadcrumb link on brief, clips and final (`packages/ui/src/components/cmp-033/PageHeader.tsx`).
