# TASK-118 accessibility and visual coverage suite

Requirements NFR-06, NFR-07; UI-UX §12; QUALITY-RELEASE-PLAN §6 (Accessibility), §8; test case TC-NFR-07.

## What it is

| Part | Path |
| --- | --- |
| Generated coverage gate | `scripts/ci/screen-coverage.mjs` |
| Frame → baseline/axe map and screen groups | `apps/web/tests/a11y/screen-map.json` |
| Playwright suite (tag `@a11y`) | `apps/web/tests/a11y/*.spec.ts`, config `apps/web/tests/a11y/playwright.config.ts` |
| Baselines this suite owns | `apps/web/tests/a11y/__baselines__/chromium/` |
| Generated report (QA-REPORT feed, UI/UX per-screen comparison) | `docs/evidence/TASK-118/screen-coverage.md`, `apps/web/reports/a11y/screen-coverage.json` |

**Gate.** The script lists every screen × state × viewport of `design/mockups/frames.json` (15 screens, 246 entries; 390 and 1440 px, plus 768 px for SCREEN-011 to 015) and fails when an entry has no axe result with zero critical or serious findings, or no committed non-empty PNG baseline. Each screen group must also have its reflow, zoom and text-spacing capture (44 captures). Negative proof: removing `fe-screen-013-saved-768.png` makes it exit 1 with `SCREEN-013 saved @768: no approved baseline`.
The per-screen specs (TASK-087 to TASK-103) own the baselines and axe results of their states; this suite adds what no spec captured and the UI-UX §12 checks. `traceability.json` is not in the repository; the script reads it when present (`--traceability`), otherwise the inventory is the frame manifest alone.

**Captures per screen group** (10 groups + final, one real page each, built web app against the running api, screen reads are labelled contract-shaped mocks): 320 px reflow, 200 % zoom (640 px = 1280 at 200 %), text-spacing override (WCAG 1.4.12) at 390 and 1440 px, each with: no page scroll sideways, no text clipped by its box, every 1440 px text still shown, axe (WCAG 2.2 AA tags) zero violations, baseline match. Also per group: colour-contrast at 390 and 1440 px, keyboard-only Tab order (document order, visible stops, focus ring, no positive tabindex), reduced motion (visible animations none), and dialog focus trap and return (campaigns delete dialog).

**Gap states** captured here (`gaps.spec.ts`): SCREEN-001 `loading` and `error` (the CMP-032 shell that `(auth)/loading.tsx` and `error.tsx` render, taken from the gallery cells because a provider load cannot be held open or failed from outside in local mode); SCREEN-006 `details-summary` (step 4 after API-024 answers 422 with eight `details[]`; the app's heading is "Check the highlighted fields and try again." where the mockup says "Fix 8 things to continue"). Mappings of other SCREEN-001/003 states use the `clerk-*` and `fe-screen-001-003-*` baselines (see the map).

## Run

From `apps/web` (needs the compiled api: `pnpm --filter @shroomap/api build`, and `E2E_DATABASE_URL`):
`CI=1 node ../../scripts/ci/screen-coverage.mjs && CI=1 pnpm exec playwright test --config tests/a11y/playwright.config.ts --grep @a11y --project=chromium`.
The bare `pnpm exec playwright test --grep @a11y` of the ticket uses `testDir: e2e` and finds none of these; the config flag is the same pattern as TASK-111. `EVIDENCE=1` refreshes `screenshots/`; `--update-snapshots` needs UI/UX approval (TASK-067).

## Findings for other lanes (outside this ticket's paths)

- `packages/ui` Button loading spinner: the hidden (invisible, reserved-space) spinner keeps `animate-spin` under `prefers-reduced-motion` (Tailwind `motion-reduce:animate-none` missing there). Not visible, so the reduced-motion test ignores invisible targets; fix belongs to the component owner.
- Phone layout moves the nav labels "Workspace", "Administration", "Invitations", "Usage report" out of view (tab bar/menu per UI-UX §7); the text-parity check lists them as wide-layout only.
