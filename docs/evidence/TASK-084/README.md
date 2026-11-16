# TASK-084 evidence: provider theming deviations, change requests, hand-offs

Frames: UI-UX §3 and §8 (SCREEN-001 sign-in, SCREEN-003 MFA). Screenshots at 390 and 1440 px are in `screenshots/` (local mode: the local form uses the shell frames exactly). The provider path (`AUTH_MODE=clerk`) is not exercised here (no keys); the deviations below are from the theming configuration in `apps/web/src/lib/auth/appearance.ts` and need UI/UX review once keys exist.

## Deviations the provider theming cannot reach (for UI/UX)

| # | Frame element | Deviation in provider mode | Handling |
|---|---|---|---|
| D-1 | Card, heading and subtitle (SCREEN-001) | Provider renders its own header block; hidden (`headerTitle`, `headerSubtitle`) and the shell's heading/description is used instead. | Matches frame; the provider's accessible name for the form remains. |
| D-2 | Footer links (SCREEN-001) | Provider footer ("Secured by", development-mode banner, sign-up link) hidden via `footer`. Provider branding cannot be removed on free plans; hiding may be limited by plan. | Record: confirm plan allows it. |
| D-3 | Input fields | Border, height, focus ring and label type come from the provider's own stylesheet; only colour, font and radius variables map to tokens. Field height/spacing may differ by a few px from the frame's Input component. | Accepted deviation, UI/UX to review. |
| D-4 | Primary button | Colour, font and radius follow tokens; provider's shadow, hover and loading spinner styling are not tokenised. | Accepted deviation. |
| D-5 | Error messages (invalid credentials, rate limit) | Provider wording and inline placement replace the frame's alert component and copy. | Frame copy is shown only in local mode. |
| D-6 | Loading and failed-to-load states | Provider shows its own skeleton; a failed script load shows nothing from the frame. | Not themed; UI/UX to decide on a fallback. |
| D-7 | MFA (SCREEN-003) code entry | Provider's OTP input styling and "use another method" links replace the frame's code input and resend text. | Accepted deviation. |
| D-8 | Session-ended alert | Frame alert is shown only in local mode (see F-4 below). | Known limitation. |

## Change request: edits outside the allowed paths (F-2)

Needed because the home route now redirects anonymous visitors to sign-in, so earlier tickets' tests and baselines for `/` changed. Files touched, for the Orchestrator's acknowledgement:

- `apps/web/e2e/brand.spec.ts`, `apps/web/e2e/design-import.spec.ts`, `apps/web/e2e/icons-gallery.spec.ts`: they now sign in through the local session before checking pages.
- `apps/web/e2e/shell-op.spec.ts` (removed, replaced by coverage in `e2e/clerk.spec.ts`) and `apps/web/e2e/__baselines__/*` (home baselines regenerated).
- `apps/web/playwright.config.ts`: ports and the local auth environment for the web server.

Requested: Orchestrator acknowledgement on this ticket, or reassign these files to their owning tickets for a follow-up.

## Hand-off: account and security link (F-3)

`AccountSecurityLink` (`apps/web/src/lib/auth/AccountSecurityLink.tsx`) is built and unit-tested but not mounted: the shell user menu is owned by the layout ticket (TASK-078, outside this ticket's allowed paths). Hand-off via Orchestrator: the layout owner (or a follow-up shell ticket) mounts it in the user menu.

## Known limitation (F-4)

In clerk mode `decideRoute` is given only `active` or `none`; the provider does not tell the middleware that a session ended, so a returning visitor lands on sign-in at the same URL with the `return` path preserved but without the "Your session ended" alert. Local mode shows the alert. Follow-up: map Clerk's session status once keys are available to test against.
