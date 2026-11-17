# TASK-093 SCREEN-007 Brief (review, edit, accept)

- `apps/web/src/features/fe-screen-007a/`: `BriefScreen` (CMP-030 shell, CMP-033 header with breadcrumb, CMP-014 stage tabs, CMP-024 segment editors, CMP-034 grid, CMP-011 alerts, CMP-003 buttons, CMP-018/019/007), copy, contract-shaped fixtures, component tests (MSW).
- Route `apps/web/src/app/(operator)/campaigns/[id]/brief/page.tsx` (noindex).
- `apps/web/e2e/fe-screen-007a.spec.ts` (`@TASK-093`): built web app against the built api; states default, accept-blocked, accepted, failed, key-missing, loading, conflict at 390 and 1440 px, axe, keyboard-only run, exact call set, real-api sign-in redirect. Baselines `apps/web/e2e/__baselines__/chromium/fe-screen-007a-*`.
- Evidence: `screenshots/`, `axe/` (zero violations); the submit-check report is the `submit-check` task document.

## What is real and what is scripted
API-041/050/051/052 and the key read are answered in e2e by contract-shaped fixtures (no operator session in this environment); the real api answers everything else. Real UI-API-DB proof is the flow ticket's.

## Decision log
| # | Question | Choice | Reason |
| --- | --- | --- | --- |
| D1 | Source of the key-missing state (no listed operation exposes it) | Read-only `GET /me/provider-keys` (API-010), also feeds the shell key badge | UI-UX §9.1 key_missing row and CMP-030; pending Solution Architect review |
| D2 | Clear-with-reason, Regenerate, Copy prompts (frames clear-reason, regenerate-confirm) | Not built here: API-053/054 are not in this ticket's operations; issues show "Edit segment" only | Ticket scope lists states default, loading, failed, accept-blocked, accepted, key-missing |
| D3 | Accept while unsaved edits / open issues | Accept uses `aria-disabled` with the reason text; pressing it shows the accept-blocked alert | Frame accept-blocked; keeps the reason reachable by keyboard |
| D4 | Conflict | 409 version_conflict keeps edits; "Show the latest version" refetches and shows the latest text under each edited segment with "Use the latest text" | UI-UX §9.1 |
| D5 | Failed state retry | "Edit answers" link only; Try again is regenerate (API-053, next ticket) | scope |
| D6 | Tabs | Tabs wrap the page body (panel) to keep aria-controls valid; Clips enabled once accepted, Final disabled | axe |
