# TASK-110 FLOW-07 end to end: delete a draft or campaign (TC-FLW-07)

- Test: `apps/web/tests/e2e/flow-07/flow-07.spec.ts` (tags `@TASK-110`, `@FLOW-07`); config `apps/web/tests/e2e/flow-07/playwright.config.ts` reuses the base config (compiled api `main.api.js` and the `next start` artifact, never the dev server) and changes only the test folder, the report folder and the server start timeout.
- Run (from `apps/web`, `CI=1`): `pnpm exec playwright test --config tests/e2e/flow-07/playwright.config.ts --project=chromium`. Needs the compiled api (`pnpm --filter @shroomap/api build`) and a database the api can start on (`E2E_DATABASE_URL`; the api needs pg-boss installed and the role session defaults).
- Screenshots (`screenshots/<step>-390.png` and `-1440.png`) and axe reports (`axe/`, zero violations at WCAG 2.2 AA at both widths):
  1. campaign list; 2. delete-confirm dialog (campaign: media removal, spent-credit warning, "cannot be undone"); 3. deleted toast, row gone;
  4. deleted record opened (one not-available message, no data, no hint); 5. draft delete-confirm; 6. draft deleted toast;
  7. cancel dialog open; 8. delete failed (500) keeps the dialog and the record; 9. record deleted meanwhile (404); 10. delete refused (403).
- Keyboard only: focus the row's delete button, Enter, Tab inside the dialog to "Delete campaign", Enter.
- Paths covered: cancel (button, Escape; the record stays, no api call, focus returns to the row's button), error (500 keeps dialog and record, no success toast, a retry then deletes), 404 meanwhile, permission (403), session expiry (ended session at the page; 401 on the delete), back (browser back from the deleted record's page returns to the list without it), real api entry point (unauthenticated delete answers 401 with the error envelope).

## What is real and what is not

The self-contained web build sends no bearer (`AppProviders` without a Clerk key), and the api accepts only Clerk or its in-process local identity, so no signed-in browser-to-api call can succeed in this stack. The data answers are therefore one stateful, contract-shaped stand-in (labelled mock, `page.route`): deleting removes the record from every later read, as the api does. Real: the built web app, routing, session middleware, SCREEN-005, SCREEN-004 and the shell, the compiled api answering the unauthenticated delete. Not exercised: the real database delete, the worker's media removal, MinIO, provider stubs, FFmpeg (api integration suites own the deletion).

## Open findings (no change made here: outside this ticket's allowed paths)

Each is pinned by a `test.fail` test that turns red the day the owner fixes it (then the annotation is removed):

- **F-07-1 (owner: record screens SCREEN-007/008/009 and the shared error presentation).** UI-UX §7 FLOW-07 and §9.1: a page load of a deleted record shows SCREEN-004 `unavailable` ("This campaign is unavailable"). The screens show a page-level alert "This page or item is not available." with Go Home inside the screen's own shell (breadcrumb "Campaign", stage tabs). The message and the no-hint rule hold (tested, step 4); the screen does not.
- **F-07-2 (owner: TASK-090, SCREEN-005).** §9.1 `unauthenticated` is a redirect to sign-in with the session-ended message. A 401 on the delete leaves the dialog open and shows the message in it; there is no redirect.
- **F-07-3 (owner: TASK-090, SCREEN-005).** §9.1 `not_found` on an action: "the dialog closes, the list refreshes, the same message appears as a toast". On a 404 the list refreshes (tested) but the dialog stays open with the message in it (step 9).

Also: the ticket's literal check cannot start from the repository root (`pnpm exec playwright` resolves only inside `apps/web`), so it runs from `apps/web` with the folder config, as TASK-111 did; the dependency report is `reports/deps.sarif`.
