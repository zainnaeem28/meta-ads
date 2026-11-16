# TASK-089 SCREEN-004 not found and unavailable record

- `apps/web/src/features/fe-screen-004/`: `NotFoundScreen` (CMP-032 message shell, CMP-003 link button, CMP-002 icons), copy of the two states (`route-404`, `unavailable`).
- `apps/web/src/app/not-found/page.tsx`: `/not-found?state=unavailable` is where a screen sends a missing, deleted or not-yours record.
- `apps/web/src/app/not-found.tsx`: one-line wiring the framework requires for unknown URLs (outside the ticket's listed paths; the file name is fixed by Next).
- No API call; "Go Home" links to `/` (signed in: campaign list; anonymous: sign-in).
- Evidence: `screenshots/` (390 and 1440 px, both states), `axe/` (zero violations), baselines in `apps/web/e2e/__baselines__/chromium/fe-screen-004-*`.

Notes for UI/UX: CMP-019 (EmptyState) cannot be used as the page's message: it has a fixed icon per variant and requires its own heading, while CMP-032 already renders the page's single `h1` from `title`. The frame's glyph (circle-help, lock) is therefore placed with CMP-002 above the button, below the message. Placing it above the heading, or letting CMP-019 take a custom icon and no duplicate heading, is a design change for UI/UX.
