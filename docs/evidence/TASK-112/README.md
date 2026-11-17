# TASK-112 FLOW-11 end to end: manage provider keys (TC-FLW-11)

- Test: `apps/web/tests/e2e/flow-11/flow-11.spec.ts` (tags `@TASK-112`, `@TC-FLW-11`); config `apps/web/tests/e2e/flow-11/playwright.config.ts` runs the compiled api (`main.api.js`) and the `next start` artifact on a throwaway database of the shared test PostgreSQL, never the dev server.
- Run (from `apps/web`, `CI=1`): `pnpm exec playwright test --config tests/e2e/flow-11/playwright.config.ts --project=chromium`. Needs `pnpm --filter @shroomap/api build` first. (The literal command from the repository root does not resolve `playwright`; same as TASK-111.)
- Screenshots `screenshots/<step>-390.png` and `-1440.png`, axe reports in `axe/` (WCAG 2.2 AA, zero violations on every step). 17 tests: 8 paths at each width plus one keyboard-only run.

## What is real and what is a labelled mock

The signed-in api answers (API-001, 010, 011, 012, 013) are a stateful contract mock in the spec (`World`): the built web sends no bearer without an identity provider and the api's local identity mints tokens only in-process, so an out-of-process operator token does not exist. The worker, provider stubs, MinIO and FFmpeg are not reachable through an unauthenticated api, so **the running job and the five worker refusals are state in the mock, not a real job**; this flow touches no assembly. The real api is exercised for the 401 door (no bearer: sign-in with the return path).

## Journey (one test) and paths

1. Empty: "Add both keys to create ads", empty trail. 2. Cancel the add dialog: nothing sent. 3. Add OpenAI with a refused key: field error, nothing stored. 4. Add with a valid key: hint and fingerprint only, never the key. 5. Add WaveSpeed: step-up dialog ("Confirm it is you"), Escape sends nothing again, retry saves. 6. Replace OpenAI under a running (stub) job: warning first; a refused replacement keeps the old key and the job running; a good one replaces it and the job fails with "key replaced during the job". 7. Delete WaveSpeed: Cancel first, then the retention text and the delete. 8. Attempt limit: "Too many attempts. Try again in 7 minutes."; the trail then shows the refusals.
Also: five refusals disable the key (notice stays until replaced), stored-untested note, 401 on save, step-up Confirm goes to sign-in with the return path, forbidden key list (no cards, no actions), browser Back, 401 at the door on the real api, keyboard-only add, replace, delete.

## Findings for the owning ticket (TASK-098, no change made here: outside this ticket's paths)

1. **Medium: a 401 while saving or deleting does not leave the screen.** The error registry marks `unauthenticated` as `presentation: 'redirect'` with a Sign-in action, but SCREEN-010's add, replace and delete mutations only show "Your session ended. Sign in to continue." inside the dialog, with no Sign-in action and no `return` path. Nothing is stored and there is no false success; the test pins this as built (`16-session-expired`). A list or trail read that gets 401 does redirect.
2. **Low: a refused save (key refused, rate limit) does not refetch the key trail.** The trail shows "test failed" or "too many attempts" after the next load, not at once; saved and deleted keys refresh it immediately.
