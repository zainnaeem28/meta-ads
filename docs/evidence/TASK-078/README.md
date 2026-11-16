# TASK-078 evidence (CMP-033 Page header, CMP-034 Page grid, CMP-032 Auth shell)

- `packages/ui/src/components/cmp-032|033|034` (subpaths `@shroomap/ui/cmp-032`, `cmp-033`, `cmp-034`; no barrel). Page header: one `h1`, description, actions, breadcrumb (`nav` "Breadcrumb", current page `aria-current`) and stage-tabs slot (CMP-014). Page grid: 12 columns from 768 px, one column under it, `col-3/4/6/8/12`, gutter 16 px / 24 px from 1024 px. Auth shell: sign-in, message, MFA; brand panel on `--surface-inverse` from 1024 px, lockup above the card below; `main` landmark, one `h1`; provider loading (busy status plus skeleton) and error (`role=alert`).
- Gallery: `apps/web/src/app/gallery/sections/fe-layout.tsx`; stage-tabs demo in `cmp-033/gallery-demos.tsx` (client).
- Tests: Testing Library + axe unit tests per component; Playwright `@TASK-078` through the built web (`next start`) beside the built api; baselines `apps/web/e2e/__baselines__/chromium/layout-{390,1440}.png` (new; UI/UX approves); axe 0 violations (`axe/`); screenshots with real Inter in `screenshots/`.

## Outside the allowed list (needed)
`packages/ui/package.json` (subpath exports), `apps/web/e2e/layout.spec.ts`, `apps/web/e2e/__baselines__/chromium/layout-*.png`.

## Limitations
- `AuthShell` has a `landmark={false}` prop used only by the gallery, to embed several shells in one page (a page can have one `main`). The embedded shells are not full viewport height.
- The CMP-014 Tabs emits `aria-controls` to a panel only when given children; the header demo supplies a panel.
- 768 px is not baselined; chromium only. The sign-in provider component itself (Clerk) is a placeholder block in the gallery; real provider wiring belongs to the auth screens.
