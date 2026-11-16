# TASK-076 evidence (CMP-022 Job card, CMP-023 Claim issue, CMP-024 Segment editor)

- `packages/ui/src/components/cmp-022` (`@shroomap/ui/cmp-022`): `JobCard` for pending, created, processing, completed and failed (temporary, configuration or credit, outcome unknown); QC passed, failed, skipped with reason; buttons named "Generate/Retry/Re-run check segment N"; outcome unknown never offers Retry; clip max 220 px on phone.
- `cmp-023`: `ClaimIssue` high risk (no clear action), other (reason field labelled, Clear disabled until a reason exists), closed.
- `cmp-024`: `SegmentEditor` zones short, within 32-42, over 42, blocked over 45 (`aria-invalid`), saving, saved; counter announced through a polite live region after an 800 ms pause, not per keystroke.
- Gallery: `apps/web/src/app/gallery/sections/fe-dom-a.tsx` (server module with `meta`); client demos in each component's `gallery-demos.tsx` (own tests).
- Tests: Testing Library + axe unit tests; Playwright `@TASK-076` through the built web (`next start`) beside the built api; baselines `apps/web/e2e/__baselines__/chromium/dom-a-{390,1440}.png` (new; UI/UX approves); axe 0 violations in `axe/`; screenshots with real Inter in `screenshots/`.

## Outside the allowed list (needed)
`packages/ui/package.json` (subpath exports), `apps/web/e2e/dom-a.spec.ts` and its baselines, `gallery-demos.tsx` files inside the component folders.

## Limitations
- Chromium only; 768 px not captured; hover and focus are not baselined.
- The completed-with-clip player branch is covered by unit test only; the gallery has no clip URL, so it shows the "Clip not available" placeholder.
- The Playwright run used a throwaway database with only the pg-boss schema (the gallery does not call the api).
