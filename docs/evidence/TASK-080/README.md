# TASK-080 evidence (CMP-031 Admin shell)

- `packages/ui/src/components/cmp-031` (subpaths `@shroomap/ui/cmp-031`, `@shroomap/ui/cmp-031/gallery-demos`; no barrel). The CMP-030 grid under `data-portal="admin"` (navy `--primary` from tokens): sticky 56 px header with a 3 px `--primary` top rule and the "Administration" portal tag (from 768 px), one `nav aria-label="Main"` (tab bar under 768 px, 64 px rail, 240 px sidebar), `main#main-content`, skip link first, toast region.
- Items in order: Accounts, Invitations, Usage report, Alerts, Settings (`/admin/*`); the tab bar uses the short labels "Invites" and "Usage" (full label as `title`). "Back to workspace" sits in the sidebar/rail foot (menu "Switch to workspace" on the tab bar).
- Alert count (`alertCount`, from API-125 by the host): badge in the sidebar and tab bar (capped at `99+`), a dot on the rail; the text "N unacknowledged" stays available to assistive tech; nothing at 0.
- `unavailable`: a non-admin (403) gets no navigation and an explanation with a link back to the workspace. The server stays authoritative; the shell does not decide roles.
- Reuses CMP-030's nav helper, layout type and document hook (`../cmp-030/...`). Navigation, sign-out and the account URL are callbacks/props; the UI package does not call the API.
- Gallery: `apps/web/src/app/gallery/sections/fe-shell-admin.tsx` (12 cells). Tests: Testing Library + axe (`AdminShell.test.tsx`); Playwright `@TASK-080` through the built web (`next start`) beside the built api; new baselines `apps/web/e2e/__baselines__/chromium/admin-*-{390,768,1440}.png` (UI/UX approves); axe 0 violations (`axe/`); screenshots with real Inter in `screenshots/`.

## Outside the allowed list (needed)
`packages/ui/package.json` (subpath exports), `apps/web/e2e/shell-admin.spec.ts`, `apps/web/e2e/__baselines__/chromium/admin-*.png`.

## Limitations
- `embedded`, `menuOpen`, `previewHover/Disabled/Focus` and `layout` props are for the gallery only; the gallery pins a layout per cell, the `auto` cell follows the viewport.
- Chromium only. The real Alerts count and the 403 fetch (API-125, API-001) are wired by the host pages (SCREEN-011..015), not in this component. E2E reaches the shell through the gallery of the built app.
- The e2e database is the shared `aiu152_e2e` test database (prepared earlier).
