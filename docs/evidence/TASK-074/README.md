# TASK-074 evidence (CMP-016 Table / list, CMP-018 Card, CMP-019 Empty and error state)

- `packages/ui/src/components/cmp-016|018|019` (subpaths `@shroomap/ui/cmp-016`, `cmp-018`, `cmp-019`; no barrel). Table: th scope=col, labelled `role=region tabindex=0` scroll region, named sort buttons with `aria-sort`, stacked labelled blocks under 768 px, states content / loading skeleton / no results (empty, no-matches) / error (Try again) / row selected / row action pending. Card: plain and section, heading level inside, loading / content / empty / unavailable, clickable card is one link on the heading. EmptyState: empty, no-matches, error (`role=alert`, Try again).
- Gallery: `apps/web/src/app/gallery/sections/fe-comp-data.tsx`; interactive demos in `packages/ui/src/components/cmp-016/gallery-demos.tsx` (client).
- Tests: Testing Library + axe unit tests per component; Playwright `@TASK-074` through the built web beside the built api; baselines `apps/web/e2e/__baselines__/chromium/comp-data-{390,1440}.png` (new; UI/UX approves); axe 0 violations (`axe/`); screenshots with real Inter in `screenshots/`.

## Outside the allowed list (needed)
`packages/ui/package.json` (subpath exports), `apps/web/e2e/comp-data.spec.ts`, `apps/web/e2e/__baselines__/chromium/comp-data-*.png`.

## Limitations
- The stacked layout (<768 px) is baselined at 390 px; 768 px not captured. Only the default gallery state is baselined per cell; chromium only. Selection is shown by background plus a screen-reader "(selected)" text (plain table, no `aria-selected`).
