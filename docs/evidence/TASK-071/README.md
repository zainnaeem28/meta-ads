# TASK-071 evidence (CMP-010 Form field, CMP-011 Alert, CMP-012 Toast)

- `packages/ui/src/components/cmp-010` (`@shroomap/ui/cmp-010`): `FormField` (valid, invalid with icon error text, disabled; help and error linked by `aria-describedby`), `FormGrid` (stacked, two columns from 768 px), `ErrorSummary` (focus on every failed submit, first 5 then "and n more", links move focus to the control, entries without a control listed without a link) and `mapDetails`/`pathNumbers` for the `details[]` rules of UI-UX 9.1. `FormDemo` is the gallery host.
- `packages/ui/src/components/cmp-011`: `Alert` (info, success, warning, destructive; `role=status`, `role=alert` for destructive).
- `packages/ui/src/components/cmp-012`: `Toast` and `ToastRegion` (success, info, error; appearing, visible, dismissed; errors and `critical` never auto-dismiss; close button named; polite and assertive live regions). `ToastDemo` is the gallery host.
- Gallery: `apps/web/src/app/gallery/sections/fe-comp-forms.tsx`.
- Tests: Testing Library + axe-core component tests; Playwright `@TASK-071` through the built web (`next start`) beside the built api; baselines `apps/web/e2e/__baselines__/chromium/comp-forms-{390,1440}.png` (new; UI/UX approves); screenshots in `screenshots/`, axe results in `axe/`.

## Limitations

- Only chromium; 768 px is not captured. The 768 px two-column grid is asserted by class only.
- The "appearing" toast is the transition's start frame (opacity 0). It sits in a dashed outline in the gallery and has its own baselines `comp-forms-toast-appearing-{390,1440}.png`; the state is also asserted by attribute.
- The Playwright run used a throwaway database with only the pg-boss schema installed (the gallery does not call the api).
- Files outside the allowed list: `packages/ui/package.json` (subpath exports), `apps/web/e2e/comp-forms.spec.ts` and its baselines, and `FormDemo.tsx`/`ToastDemo.tsx` inside the component folders.
