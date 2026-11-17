# TASK-099 SCREEN-011 admin accounts

- `apps/web/src/app/(admin)/admin/accounts/page.tsx`: the `/admin/accounts` route (noindex), renders `AccountsScreen`.
- `apps/web/src/features/fe-screen-011/`: `AccountsScreen` (CMP-031 shell, CMP-016 tables, CMP-017 filter bar, CMP-007 badges, CMP-013 dialogs, CMP-020 row menu, CMP-011 through `ErrorNotice`), `copy.ts`, `format.ts`, `fixtures.ts`.
- API: API-100 (list, `status` filter, cursor paging), 101, 102, 103 (typed email confirmation), 104 (`If-Match: "<version>"` from the row), 105 (erasures tab), 111 (invite dialog; recorded design-matrix gap, no new API).
- Errors handled with the §9.1 copy: `last_admin`, `self_action` (alert above the table, Close), `confirmation_mismatch` (inside the remove dialog), `version_conflict`, `recent_auth_required` (step-up dialog), `invite_domain_not_allowed` (under the email field), `forbidden_role` (shell unavailable state).
- States at 390, 768 and 1440 px: default, loading, error, only-you, invite-dialog, suspend-confirm, remove-confirm, last-admin, erasures, menu-open. Screenshots in `screenshots/`, axe results (zero violations) in `axe/`, baselines in `apps/web/e2e/__baselines__/chromium/fe-screen-011-*`.
- Tests: `AccountsScreen.test.tsx` (MSW, 17 tests); `apps/web/e2e/fe-screen-011.spec.ts` (`@TASK-099`, 35 tests).

Decision log (design gaps, no new API fields):
- The frame's "Two-step" and "Last active" columns have no field in `AdminUser` (API-100). They are not shown; "Added" (`createdAt`) takes their place. A removed account shows "Erasing: step n of 5" from `erasure.step`.
- The frame names accounts by person ("Marcus Oyelaran"); the API has no name, so dialogs use the email.
- API-100 has no search; the filter bar's search narrows the loaded page by email only, and the status chips call the API (`status` in the URL).
- Role `user` is labelled "Operator" as in the frame. Erasure step names for 1, 2 and 4 come from ARCHITECTURE §5.8; 3 and 5 match the frame.
- The self row's quick Suspend stays enabled as in the frame and the API answers `last_admin` or `self_action`; its menu items are disabled (§9.1).

Limits: e2e state tests answer API-100..105 and API-111 with contract-shaped route mocks (no administrator session exists without the identity provider); one test calls the real built api and checks the 401 redirect to sign-in. The administrator journey against the real api is the flow ticket. The shell is mounted by the screen itself (no `(admin)` layout in the allowed paths).
