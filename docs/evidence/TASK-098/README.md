# TASK-098 SCREEN-010 provider keys (add, test, replace, delete, event trail)

- `apps/web/src/app/(operator)/settings/provider-keys/page.tsx`: the `/settings/provider-keys` route, renders `ProviderKeysScreen`.
- `apps/web/src/features/fe-screen-010/`: `ProviderKeysScreen` (per-provider card with hint and fingerprint only, add/replace dialog, delete confirm, step-up dialog, disabled notice, key-event trail), `copy.ts` (UI-UX §8 and §9.1 copy).
- API: only API-001 (`GET /me`), API-010 (list), API-011 (`PUT`, add or replace, tests the key), API-012 (`DELETE`), API-013 (key events).
- Errors handled: key_invalid, rate_limited, recent_auth_required, validation_failed, not_found.
- States at 390 and 1440 px: default, loading, empty, add-dialog, testing, validation-error, rate-limited, step-up, saved, untested, replace-warning, delete-confirm, disabled. Screenshots in `screenshots/`, axe results in `axe/`, Playwright baselines in `apps/web/e2e/__baselines__/chromium/fe-screen-010-*`.
- Tests: `ProviderKeysScreen.test.tsx` (MSW, 19 tests); `apps/web/e2e/fe-screen-010.spec.ts` (`@TASK-098`, 30 tests).

Limits to know:
- The e2e state tests answer API-001 and API-010..013 with contract-shaped route mocks (labelled in the spec); the `real api` test calls the running built api through the built web app and checks it answers 401 and sends the user to sign-in. The operator journey against the real api is the flow ticket.
- The key is held only in the dialog field, never rendered, and cleared after every outcome.
