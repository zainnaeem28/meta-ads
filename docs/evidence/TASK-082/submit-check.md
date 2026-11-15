# TASK-082 evidence

Submit-check report for the submitted commit is attached to the task as `submit-check`.

## Changes outside the allowed paths (change-request note for the Orchestrator)
Unavoidable wiring: `apps/web/src/app/layout.tsx` (mount `AppProviders`), `apps/web/src/app/api-probe/**` (test-only page, 404 unless the e2e build sets `NEXT_PUBLIC_E2E_PROBE=1`), `apps/web/e2e/`, `apps/web/playwright.config.ts` (the e2e builds the web with the api origin and probe flag, then `next start`), `apps/web/vitest.config.ts` and `apps/web/package.json` (MSW, coverage, junit), root `eslint.config.mjs` (no direct `fetch` in components), `pnpm-lock.yaml`.

## Review round 1 responses
F-1 fixed: install moved into a browser-only layout effect (StrictMode test added). F-2 fixed (no install on the server). F-3 fixed: probe uses the root provider's client; origin from `NEXT_PUBLIC_API_ORIGIN`. The api sets no CORS yet, so the test still answers CORS via `page.route`. F-4 fixed: probe returns 404 without the flag. F-5: recorded above. F-6 fixed: polling also stops when the query is in error state (test added). F-7: no screens in this ticket.
