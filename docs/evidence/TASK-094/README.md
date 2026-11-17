# TASK-094 SCREEN-007 Brief (claim issues, regenerate, copy prompts)

- `apps/web/src/features/fe-screen-007b/`: `BriefScreen` (the TASK-093 screen plus API-054 clear-with-reason, API-053 regenerate behind a CMP-013 confirm dialog, Try again on a failed brief, and Copy segment prompts on an accepted brief), copy, fixtures, component tests (MSW).
- Route `apps/web/src/app/(operator)/campaigns/[id]/brief/page.tsx` now renders the 007b screen.
- `apps/web/e2e/fe-screen-007b.spec.ts` (`@TASK-094`): states default, accept-blocked, clear-reason, regenerate-confirm, accepted, failed, key-missing, conflict, loading at 390 and 1440 px with axe (zero violations), keyboard-only runs, exact call set, clipboard check. Baselines `apps/web/e2e/__baselines__/chromium/fe-screen-007b-*`. Run: `node docs/evidence/TASK-094/e2e-with-database.mjs` after `pnpm --filter @shroomap/api build`.
- Evidence: `screenshots/`, `axe/`.

## Decision log
| # | Question | Choice | Reason |
| --- | --- | --- | --- |
| D1 | Extend 007a in place or copy | 007b holds a full copy of the screen extended; 007a is outside this ticket's allowed paths and is no longer routed | Allowed paths. Follow-up for the Orchestrator: remove `fe-screen-007a` source once nothing imports it |
| D2 | Issue row: CMP-023 or the frame markup | Frame markup kept (edit link, "Clear with reason" opening an inline textarea, Clear issue, Cancel); CMP-023 has no edit link and an Input, so it cannot match the frame | Frame parity SCREEN-007 `clear-reason` |
| D3 | Regenerate when the key is missing or disabled | Button disabled; the key banner explains | UI-UX §9.1 key_missing, key_disabled |
| D4 | Copy prompts format | One block per active segment: "Segment N · m:ss to m:ss" then its visual prompt; disabled until Accepted and while edits are unsaved; clipboard refusal shows the text to copy by hand | REQ-030 |
| D5 | e2e spec location | `apps/web/e2e` (Playwright `testDir`), outside the listed paths, as for TASK-093 | Config |
| D6 | API-053/054 e2e | Scripted contract-shaped answers; real UI-API-DB proof is the flow ticket's | Same as TASK-093 |
