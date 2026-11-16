# TASK-073 evidence (CMP-014 Tabs, CMP-015 Stepper, CMP-017 Filter bar and pagination)

- `packages/ui/src/components/cmp-014|015|017` (subpaths `@shroomap/ui/cmp-014`, `cmp-015`, `cmp-017`; no barrel). Tabs: underline, count badges, selected/default/disabled, roving focus, arrow/Home/End. Stepper: ordered list "Progress", `aria-current=step`, phone shows only the current label. FilterBar: single-select toggle chips with counts (`aria-pressed`), Clear all, NoMatches; Pagination: "n rows", Previous/Next; `?q&status&page` helpers in `list-state.ts`.
- Gallery: `apps/web/src/app/gallery/sections/fe-comp-nav.tsx` (server component with `meta`); interactive demos in `packages/ui/src/components/cmp-014/gallery-demos.tsx` (client; own test) because a `use client` section file would lose its `meta` export.
- Tests: Testing Library + axe unit tests; Playwright `@TASK-073` through the built web beside the built api; baselines `apps/web/e2e/__baselines__/chromium/comp-nav-{390,1440}.png` (new; UI/UX approves); axe 0 violations (`axe/`); screenshots with real Inter in `screenshots/`.

## Outside the allowed list (needed)
`packages/ui/package.json` (subpath exports), `apps/web/e2e/comp-nav.spec.ts`, `apps/web/e2e/__baselines__/chromium/comp-nav-*.png`.

## Limitations
- Hover and focus states are reachable (pointer, Tab) but only the default gallery state is baselined; chromium only; 768 px not captured.
