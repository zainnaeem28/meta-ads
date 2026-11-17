# TASK-111 FLOW-10 end to end: not found and home route (TC-FLW-10)

- Test: `apps/web/tests/e2e/flow-10/flow-10.spec.ts` (tag `@TASK-111`, `@FLOW-10`); config `apps/web/tests/e2e/flow-10/playwright.config.ts` reuses the base config (built api `main.api.js` and `next start` artifact, never the dev server) and changes only the test folder and report folder.
- Run (from `apps/web`, `CI=1`): `pnpm exec playwright test --config tests/e2e/flow-10/playwright.config.ts --project=chromium`. Needs the compiled api (`pnpm --filter @shroomap/api build`) and a database the api can start on (`E2E_DATABASE_URL`).
- Steps and screenshots (`screenshots/<step>-390.png` and `-1440.png`, axe reports in `axe/`, zero violations at WCAG 2.2 AA):
  1. signed in, unknown URL (`/no/such/page?x=1#frag`): real 404 status, "Page not found", noindex, title; Tab then Enter on "Go Home" (keyboard only), no api call from SCREEN-004
  2. Go Home lands on `/campaigns` (SCREEN-005)
  3. `unavailable` variant (`/not-found?state=unavailable`): one message, no hint; Go Home reaches the list
  4. anonymous, unknown URL: goes to sign-in with `return=/no/such/page`; `/` goes to sign-in with no return
  5. ended session on an unknown URL: sign-in with the "Your session ended" message
- Paths covered: back (browser back returns to the not-found page), error (404 status, never 200; tampered cookie treated as anonymous), session expiry, permission (anonymous sees neither SCREEN-004 state). Cancel does not exist in this flow (one action).

## Findings for the owning tickets (no change made here: outside this ticket's paths)

1. **Anonymous visitors never see SCREEN-004.** UI-UX §7 reads "any unknown URL → SCREEN-004 → Go Home, anonymous Go Home goes to sign-in". The route policy (TASK-084 area, `route-policy.ts`) sends an anonymous visitor on any unknown URL to sign-in first, so the anonymous Go Home click cannot happen; the observable behaviour is unknown URL → sign-in (return path kept). Same for the `unavailable` page. The test pins the behaviour as built; UI/UX or the owner of the policy decides whether to keep it (it also avoids revealing which URLs exist to anonymous visitors).
2. **The campaign list shows its error state under the local test session.** The e2e local session cookie is not a credential the real api accepts, so after Go Home the list answers "Something went wrong on our side" (step 2 screenshot). The landing, shell and route are verified; list data after sign-in through the real identity path is covered by the sign-in/list flow tickets, not here.
3. **The ticket's literal check cannot start from the repository root:** `pnpm exec playwright` resolves only inside `apps/web` (no root dependency) and the base config's `testDir` is `e2e`. The check therefore runs from `apps/web` with the folder config above (see `submit-check.md`). Also the deps report is `reports/deps.sarif` (what `scripts/ci/deps.sh` writes), not `deps.json`.

Not exercised: the worker, MinIO, provider stubs and FFmpeg: this flow touches none of them.
