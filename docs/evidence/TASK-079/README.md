# TASK-079 evidence (CMP-030 Operator shell)

- `packages/ui/src/components/cmp-030` (subpaths `@shroomap/ui/cmp-030`, `@shroomap/ui/cmp-030/gallery-demos`; no barrel). One shell: skip link first, sticky 56 px header (logo link, key-state badge, avatar menu CMP-020), one `nav aria-label="Main"` that is the 64 px bottom tab bar under 768 px, the 64 px icon rail from 768 px (labels `sr-only` plus `title`) and the 240 px sidebar from 1024 px, `main#main-content`, toast region (CMP-012). Items in order: Campaigns, New brief, Provider keys. States: default, hover, focus (2 px ring), current (`aria-current`, `--sidebar-accent`, 3 px `--primary` marker), disabled (`aria-disabled`), collapsed rail, menu open.
- Avatar menu: "Signed in as Operator|Administrator", Provider keys, Switch to administration (admins only), Account and security (new tab, `noopener`), Sign out. Navigation and sign-out are callbacks (`onNavigate`, `onSignOut`); the host wires the router and the provider.
- Key badge: `deriveKeyState(API-010 list)` returns `ok | missing | disabled` (disabled wins, then any unconfigured provider); the badge reads "Add provider keys" (warning) or "Key disabled" (destructive) and links to `/settings/provider-keys`. The host fetches API-010/API-001 with the API client (TASK-082) and passes `keyState`; the UI package does not call the API.
- `useShellDocument(page)` sets the title "Page · ShrooMap" and `<meta name="robots" content="noindex">` and restores both on unmount.
- Gallery: `apps/web/src/app/gallery/sections/fe-shell-operator.tsx` (nine cells). Tests: Testing Library + axe unit tests; Playwright `@TASK-079` through the built web (`next start`) beside the built api; baselines `apps/web/e2e/__baselines__/chromium/shell-*-{390,768,1440}.png` (new; UI/UX approves); axe 0 violations (`axe/`); screenshots with real Inter in `screenshots/`.

## Outside the allowed list (needed)
`packages/ui/package.json` (subpath exports), `apps/web/e2e/shell-op.spec.ts`, `apps/web/e2e/__baselines__/chromium/shell-*.png`.

## Limitations
- `embedded`, `menuOpen`, `previewHover` and `layout` props exist for the gallery only; the gallery pins a layout per cell because the viewport decides it in the product (the `auto` cells follow the viewport).
- The role `admin` shell here is the operator shell with the portal switch; the admin shell (CMP-031) is a separate ticket.
- Chromium only. "Account and security" URL (`accountUrl`, default `/account`) is supplied by the host from the provider configuration.
- Gallery frames are narrower than the viewport, so the header shows the logo mark under 320 px container width (container query) and the lockup otherwise; at a real 390 px viewport the lockup shows.
