# TASK-100 SCREEN-012 Invitations and access requests

- `apps/web/src/features/fe-screen-012/`: `InvitationsScreen` (CMP-031 shell, CMP-014 tabs, CMP-016 tables, CMP-013 dialogs, CMP-012 toasts via the shell, CMP-019 empty states, CMP-007 badges, CMP-010/004 field), copy, formatting, contract-shaped fixtures, component tests (MSW).
- `apps/web/src/app/(admin)/admin/invitations/page.tsx`: the route `/admin/invitations` (noindex, title "Invitations and requests · ShrooMap").
- `apps/web/e2e/fe-screen-012.spec.ts` (`@TASK-100`): built web app (`next start`) against the built api, all seven states at 390, 768 and 1440 px, axe, keyboard-only run, the exact set of calls, the real api's answer without an administrator session, anonymous redirect. Baselines: `apps/web/e2e/__baselines__/chromium/fe-screen-012-*`.
- Evidence: `screenshots/` (every state, three widths, real Inter fonts), `axe/` (zero violations on every state, WCAG 2.2 AA tags), `submit-check.md`.

## What is real and what is scripted

The api in the e2e run is the built api, but this environment has no administrator session for it, so the eight SCREEN-012 operations are answered by the test with contract-shaped fixtures (labelled in the spec). Every other request, and the "real api" test, reach the real api (which answers an unauthenticated read). Real UI to API to database integration of the admin journey is the flow ticket's proof.

## Decision log (frontend decisions, for the Solution Architect Reviewer / UI/UX)

| # | Question | Choice | Reason |
| --- | --- | --- | --- |
| D1 | How does the page know sign-up mode / whether the form is on (`requests-off`)? None of the listed operations says. | Read-only `GET /admin/settings` (API-120), using `signupMode === 'open'` or `accessRequestFormEnabled === false` as "off"; the requests list (API-115) is not called when off. | UI-UX §8 requires the state; API-120 is the only operation that exposes it, and it is already in the contract. Adds one read call beyond the ticket's list. **Status: pending the Solution Architect's decision (review FR-3); if rejected the page must be given the value another way.** |
| D2 | The ticket's "API-002" is `GET /me` (the access-request create call is the requester's, not an admin's). | `GET /me` is called once to learn the signed-in administrator's ID. | Listed in the ticket; it is the only listed operation that identifies the current administrator. |
| D3 | `invitedBy` is a user ID; the frame shows "You" / a name. | "You" when it equals the `/me` ID, "Admin" for another administrator, "System" when null (no ID or email shown; the API has no name for another user). | Meaningful to the administrator and within the listed operations (review FR-2). |
| D4 | Revoke is destructive and not in the frame. | Confirm dialog (CMP-013) before API-113. | Prevents an accidental revoke; same dialog component. |
| D5 | Expired invitation action. | "Invite again" opens the invite dialog with the address filled in and calls API-111 (no resend of an expired invitation: API-112 returns `state_conflict`). | Matches the frame and the contract. |
| D6 | Error mapping (UI-UX §9.1). | `invite_domain_not_allowed` and `validation_failed` on the field; `state_conflict` alert with Refresh; `recent_auth_required` step-up dialog (nothing resubmitted automatically); `forbidden_role` shows the shell's unavailable state; other failures use the shared error presentation. | §9.1 rows. |
| D7 | Tab counts. | Number of rows in the first page (up to 50); no count while loading or when requests are off. | Honest counts; no extra count call exists. |

Limitations: the admin shell layout is not shared via an `(admin)/layout.tsx` (outside the allowed paths), so the page renders `AdminShell` itself; the alert badge (API-125) is not fetched here (sidebar shows no count). Pagination beyond the first 50 rows is not built (API supports a cursor).

## 768 px layout (review FR-1)

The Actions column was clipped at 768 px. Addresses now wrap after the `@` (never inside a word), the two row actions stack at 768 px and sit side by side from 1024 px, and "Invited by" is short. `capture()` in the spec asserts every visible row action lies inside the viewport at all three widths. Baselines and screenshots were regenerated.

## Paths outside the ticket's list (review FR-5)

`apps/web/e2e/fe-screen-012.spec.ts` and `apps/web/e2e/__baselines__/chromium/fe-screen-012-*` follow the repository's Playwright convention (the ticket requires the `@TASK-100` Playwright run and baselines).
