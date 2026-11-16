# TASK-101 SCREEN-013 Admin settings: sign-up mode and read-only security configuration

- `apps/web/src/app/(admin)/admin/settings/page.tsx`: the route `/admin/settings`, wrapped by `SettingsScreen` in CMP-031 (the `(admin)` route group has no shared layout yet, so the shell is applied in the screen).
- `apps/web/src/features/fe-screen-013/`: `SettingsScreen` (API-120 via `useAdminGetSettings`, API-121 via `useAdminSetSignupMode`), `SettingsView` (CMP-033 header, CMP-018 cards, CMP-006 radio cards, CMP-007 badges, CMP-003 button, CMP-011 alert and CMP-013 step-up through the shared `ErrorNotice`, CMP-012 toast through the shell), `copy.ts`.
- States: default, loading, open-refused (`signup_open_prerequisites`: warning alert "Open sign-up cannot be turned on yet." plus the server message; the choice returns to Invited only), saved (toast "Sign-up mode saved."), step-up (`recent_auth_required`), 403 unavailable, load error with Try again.
- Evidence: `screenshots/` (default, open-refused, saved, loading at 390, 768 and 1440 px), `axe/` (zero violations), baselines in `apps/web/e2e/__baselines__/chromium/fe-screen-013-*`.
- The e2e runs the built web app (`next start`) against the built api on PostgreSQL. The two admin operations are scripted (contract-shaped) because the local test session is not an administrator of the real api; the real api answers the unauthenticated entry-point test (401, redirect to sign-in). Real admin integration is the flow ticket.

Notes for UI/UX and Architect:
- Frame vs UI-UX §9.1: the frame draws the refusal as a destructive alert with a bullet list; §9.1 prescribes a warning alert beside the switch with the server message. Built per §9.1; the prerequisite status rows under the switch name what is missing.
- API-120 returns no invitation lifetime. The row "Invitation lifetime: 7 days" shows the api default (`INVITE_EXPIRY_DAYS=7`) as a constant in `copy.ts`; it would be wrong if the deployment overrides it. Proposed contract change for the Architect: add `inviteExpiryDays` to `Settings`.
- The full-page screenshot at 390 px shows the fixed bottom tab bar over the page body (a capture artifact of the sticky nav).
