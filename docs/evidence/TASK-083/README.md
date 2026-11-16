# TASK-083 evidence: error presentation (UI-UX §9.1)

Submit-check report for the submitted commit is attached to the task as `submit-check`.

## What is built
- `apps/web/src/lib/errors/`: the 36-row copy table (`copy.ts`), `resolveError` (branches on `error.code` only; unknown codes, plain errors and transport failures use the `internal_error` row; a server message is shown only on rows that name one and only after screening), the retry countdown hook (`countdown.ts`), `details[]` mapping over CMP-010 (`details.ts`), the safe sign-in return path (`session.ts`), the defect log for `method_not_allowed` and `idempotency_key_reused` (`defect.ts`).
- `apps/web/src/components/errors/`: `ErrorNotice` (CMP-019 page, CMP-011 alert, toast, field summary, redirect), `RetryButton`, `ReferenceLine`, `QcConfirmDialog`, `StepUpDialog`.

## Acceptance mapping
| Acceptance | Proof |
| --- | --- |
| Table test, 36 codes + unknown fallback | `lib/errors/copy.test.ts` (each code: copy, action, presentation; unknown/plain/transport fall back) |
| No status, stack, table name or provider detail in any message | `copy.test.ts` "copy lint" over every row, with and without server text and wait; server messages screened by `safeServerMessage` |
| Countdown, announcements only at start and availability | `components/errors/RetryButton.test.tsx` (fake timers: exactly two distinct announcements) |
| Through the real entry point | `e2e/error-presentation.spec.ts` (`@TASK-083`): built web (`next start`) against the running built api; real api `not_found` on GET /me; scripted contract-shaped 503/500/401/422 for the write endpoint |
| Retry presentation | 503 + `Retry-After: 3`: disabled "Try again in Ns", "Check the list before you repeat this" (job-creating), Reference + Copy, retry sends the same `Idempotency-Key`; 500: three failures show the administrator hint |
| Session expired | 401 redirects to `/sign-in?reason=session-expired&return=<safe path>`; unsafe returns collapse to `/` (`session.test.ts`) |

Screenshots (390 and 1440, real fonts) and axe results (WCAG 2.2 AA, zero violations): `screenshots/`, `axe/`. Frames for the 500/503 alert, the `qc-confirm-required` variant and the details summary are still "to be added" in UI-UX §9.1, so UI/UX compares these against the written specification.

## Changes outside the allowed paths (change-request note for the Orchestrator)
- `apps/web/src/lib/api/errors.ts`, `client.ts`: the API client dropped `Retry-After`; `ApiClientError.retryAfterSeconds` now carries it (whole seconds, minimum 1). Required for the countdown. Test is in `lib/errors/retry-after.test.ts`.
- `apps/web/src/app/error-probe/**` (test-only page, 404 unless the e2e build sets `NEXT_PUBLIC_E2E_PROBE=1`) and `apps/web/e2e/error-presentation.spec.ts`: the entry point for the e2e, as in TASK-082.

## Limitations
- The `/sign-in`, `/access`, `/mfa` and campaign screens do not exist yet; their paths are the proposed routes of UI-UX §7 in `lib/errors/routes.ts`. The global wiring of 401 handling into the query client belongs with the screen tickets; this ticket supplies `ErrorNotice`, `redirectTarget` and `signInUrl`.
- The write-endpoint answers in the e2e are scripted from the contract, not produced by the api; only the `not_found` case is a real api answer.
- `reports/deps.json` is a copy of the dependency audit (`reports/audit.json`) so the ticket's flag resolves.
