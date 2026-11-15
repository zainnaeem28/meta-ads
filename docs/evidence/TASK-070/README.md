# TASK-070 evidence (CMP-007 Badge, CMP-008 Loading)

- `packages/ui/src/components/cmp-007` (`@shroomap/ui/cmp-007`): `Badge` with variants neutral, primary, success, info, warning, destructive; one size; text is always the label, optional decorative icon.
- `packages/ui/src/components/cmp-008` (`@shroomap/ui/cmp-008`): `Spinner` (visible text status), `Progress` (`role="progressbar"`, value when determinate, indeterminate without value), `Skeleton` + `SkeletonRegion` (`aria-busy="true"` with visible text status). Animations are off under `prefers-reduced-motion`.
- Gallery: `apps/web/src/app/gallery/sections/fe-prim-b.tsx` (every variant and state).
- Tests: Testing Library + axe-core component tests (`*.test.tsx`, jsdom, 100 % lines/branches); Playwright `@TASK-070` through the built web (`next start`) beside the built api; visual baselines `apps/web/e2e/__baselines__/chromium/prim-b-{390,1440}.png` (new; UI/UX approves); axe 0 violations at 390 and 1440 (`axe/`); screenshots in `screenshots/` with real Inter.

## Files outside the allowed list (needed)

- `packages/ui/package.json` (subpath exports `./cmp-007`, `./cmp-008`; dev dependencies jsdom 27.4.0, @testing-library/{react,dom,jest-dom}, axe-core 4.10.3, @vitest/coverage-v8), `packages/ui/vitest.config.ts` (`NODE_ENV=test`, setup file), `packages/ui/vitest.setup.ts`, `packages/ui/tsconfig.json`, `pnpm-lock.yaml`, `apps/web/e2e/prim-b.spec.ts` and `apps/web/e2e/__baselines__/chromium/prim-b-*.png`.
- Coverage/junit for the ui package are written to `apps/web/reports/prim-b/` via CLI flags; the lcov paths are rewritten to repo-relative.

## Limitations

- Only chromium was run. The 768 px viewport is not captured (the ticket asks 390 and 1440 for these components).
