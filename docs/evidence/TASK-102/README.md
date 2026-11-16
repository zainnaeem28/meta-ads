# TASK-102 SCREEN-014 admin alerts (list and acknowledge)

- `apps/web/src/app/(admin)/admin/alerts/page.tsx`: the `/admin/alerts` route (noindex), renders `AlertsScreen`.
- `apps/web/src/features/fe-screen-014/`: `AlertsScreen` (CMP-031 shell with the unacknowledged count, CMP-018 card, CMP-007 badges, CMP-019 empty state through the card, CMP-003 buttons), `copy.ts` (UI-UX §7 frame copy per alert kind, user IDs shortened to `u_c07e…9b30`, no email anywhere).
- API: only API-125 (`GET /admin/alerts?limit=50`, "Show more" follows `nextCursor`) and API-126 (`POST /admin/alerts/{id}/acknowledge`). Acknowledge updates the cached row, shows the toast "Alert acknowledged." and lowers the shell badge.
- Errors: `forbidden_role` shows the shell's unavailable state (no navigation); `recent_auth_required` shows the §9.1 step-up dialog ("Confirm it is you", "Confirm sign-in" goes to sign-in with return `/admin/alerts`), on the list and on Acknowledge. Other codes use `ErrorNotice`.
- States: default, empty, loading, acknowledged at 390, 768 and 1440 px. Screenshots in `screenshots/`, axe results (zero violations) in `axe/`, Playwright baselines in `apps/web/e2e/__baselines__/chromium/fe-screen-014-*`.
- Tests: `AlertsScreen.test.tsx` (MSW, 11 tests); `apps/web/e2e/fe-screen-014.spec.ts` (`@TASK-102`, 16 tests).

Limits to know:
- The e2e state tests answer API-125/126 with contract-shaped route mocks (the test account has no administrator session without the identity provider). One test (`real api`) calls the running built api through the built web app and checks it answers 401 and sends the user to sign-in with the return path. The administrator journey against the real api is the flow ticket.
- The shell is mounted by the screen itself (`AdminShell`), because the ticket's allowed paths exclude an `(admin)` layout. A shared admin layout from the sibling admin tickets would replace that wrapper; the screen's content does not change.
- Times use the browser's time zone; the e2e pins UTC and the clock.
