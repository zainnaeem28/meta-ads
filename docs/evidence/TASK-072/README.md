# TASK-072 evidence (CMP-013 Dialog, CMP-020 Menu)

- `packages/ui/src/components/cmp-013` (`@shroomap/ui/cmp-013`): `Dialog` (modal, portal, focus moved in and trapped, Escape closes, focus returned, overlay press closes) and `DialogPanel` (the card; `inline` shows a state on the gallery page as a group). Variants: confirm, typed confirm (confirm stays disabled until the exact text), form. States: open, pending (locks cancel, Escape, overlay), error (alert), dirty-discard ("Discard changes?" with Keep editing / Discard; Escape returns to editing). 480 px max width, phone full width less 24 px. Tokens: `--popover`, `--overlay`.
- `packages/ui/src/components/cmp-020` (`@shroomap/ui/cmp-020`): `Menu` (`aria-haspopup=menu`, `role=menuitem`, ArrowDown/Up open on first/last, arrows wrap and skip disabled, Home/End, Escape returns focus, outside press and Tab close). Variants: account menu (header block), row action menu. Min width 220 px; phone spans its positioned ancestor less 24 px. Tokens: `--popover`, `--shadow-md`.
- Gallery: `apps/web/src/app/gallery/sections/fe-comp-overlay.tsx`; demos in `cmp-013/gallery-demos.tsx` (every dialog state, live modal buttons, menu open/focus/disabled/closed).
- Tests: Testing Library + axe unit tests (UI package coverage ~98 %); Playwright `@TASK-072` through the built web beside the built api on real PostgreSQL; new baselines `apps/web/e2e/__baselines__/chromium/comp-overlay-{390,1440}.png` (UI/UX approves); axe 0 violations in `axe/`; screenshots with real Inter in `screenshots/`.

## Outside the allowed list (needed)
`packages/ui/package.json` (subpath exports), `apps/web/e2e/comp-overlay.spec.ts`, the baselines above.

## Limitations
- Item hover and focus on closed menu are reachable by pointer/keyboard; the item-focus state is baselined via `initialFocus`. Chromium only; 768 px not captured.
- Phone menu is positioned against its nearest positioned ancestor (not the viewport).
